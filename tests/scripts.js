const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const acorn = require('acorn');

const root = path.join(__dirname, '..');
const scripts = [
    { file: 'vaft/vaft.user.js', worker: true },
    { file: 'vaft/vaft-ublock-origin.js', worker: true },
    { file: 'video-swap-new/video-swap-new.user.js', worker: true },
    { file: 'video-swap-new/video-swap-new-ublock-origin.js', worker: true },
    { file: 'strip/strip.user.js', worker: true },
    { file: 'vaft/twitch-brave-fix.user.js', worker: false },
    { file: 'vaft/twitch-brave-fix-ublock-origin.js', worker: false }
];

function readScript(file) {
    const ref = process.env.TWITCH_TEST_SCRIPT_REF;
    const text = ref && scripts.some(script => script.file === file)
        ? execFileSync('git', ['show', ref + ':' + file], { cwd: root, encoding: 'utf8' })
        : fs.readFileSync(path.join(root, file), 'utf8');
    return file.includes('ublock-origin') ? text.slice(text.indexOf('\n') + 1) : text;
}

function scriptNodes(source) {
    const nodes = [];
    function visit(node) {
        if (!node || typeof node !== 'object') return;
        if (node.type) nodes.push(node);
        for (const value of Object.values(node)) {
            if (Array.isArray(value)) value.forEach(visit);
            else if (value && typeof value === 'object') visit(value);
        }
    }
    visit(acorn.parse(source, { ecmaVersion: 2022 }));
    return nodes;
}

function createScriptContext(source, bindings = {}, nodes = scriptNodes(source)) {
    const declarations = nodes.filter(node => node.type === 'FunctionDeclaration');
    const context = vm.createContext(bindings);
    vm.runInContext(declarations.map(node => source.slice(node.start, node.end)).join('\n'), context);
    vm.runInContext('declareOptions(globalThis)', context);
    return context;
}

function serializedWorker(source) {
    const nodes = scriptNodes(source);
    const template = nodes.find(node => node.type === 'VariableDeclarator' && node.id.name === 'newBlobStr').init;
    const context = createScriptContext(source, { console, URL, twitchBlobUrl: 'blob:https://www.twitch.tv/fixture' }, nodes);
    return vm.runInContext(source.slice(template.start, template.end), context);
}

module.exports = { root, scripts, readScript, scriptNodes, createScriptContext, serializedWorker };
