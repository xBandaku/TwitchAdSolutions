const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');
const acorn = require('acorn');
const { root, scripts, readScript, scriptNodes, serializedWorker } = require('./scripts');

const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).trim().split(/\r?\n/);
const canonical = node => JSON.stringify(node, function(key, value) {
    if (['start', 'end', 'raw'].includes(key)) return undefined;
    // The parsed worker is compared separately because template comments are string values.
    if (this.type === 'VariableDeclarator' && this.id.name === 'newBlobStr' && key === 'init') return { type: 'SerializedWorker' };
    return value;
});

test('the script inventory includes every installable variant', () => {
    const installable = files.filter(file => /(?:\.user\.js|ublock-origin[^/]*\.js)$/.test(file));
    assert.deepEqual(scripts.map(script => script.file).sort(), installable.sort());
});

for (const file of files.filter(file => /\.(?:js|cjs|mjs)$/.test(file))) {
    test(file + ' parses', () => {
        acorn.parse(readScript(file), { ecmaVersion: 2022, sourceType: file.endsWith('.mjs') ? 'module' : 'script' });
    });
}

for (const script of scripts) {
    test(script.file + ' has valid installation metadata', () => {
        const text = fs.readFileSync(path.join(root, script.file), 'utf8');
        if (script.file.includes('ublock-origin')) {
            const resource = script.file.includes('brave-fix') ? 'twitch-brave-fix.js' : 'twitch-videoad.js';
            assert.equal(text.split(/\r?\n/)[0], resource + ' text/javascript');
            return;
        }
        const metadata = new Map([...text.matchAll(/^\/\/ @(\S+)[ \t]+(.+)$/gm)].map(match => [match[1], match[2].trim()]));
        assert.ok(text.startsWith('// ==UserScript=='));
        assert.ok(text.includes('// ==/UserScript=='));
        assert.match(metadata.get('version'), /^\d+(?:\.\d+)+(?:[a-zA-Z][\w.-]*)?$/);
        assert.equal(metadata.get('run-at'), 'document-start');
        assert.equal(metadata.get('match'), '*://*.twitch.tv/*');
        for (const key of ['updateURL', 'downloadURL']) {
            const url = new URL(metadata.get(key));
            assert.equal(url.protocol, 'https:');
            assert.ok(['github.com', 'raw.githubusercontent.com'].includes(url.hostname));
            assert.ok(url.pathname.startsWith('/xBandaku/TwitchAdSolutions/'));
            assert.ok(url.pathname.endsWith('/' + script.file));
        }
    });
    if (script.worker) {
        test(script.file + ' serializes a complete worker', () => {
            acorn.parse(serializedWorker(readScript(script.file)), { ecmaVersion: 2022 });
        });
    }
}

for (const pair of [
    ['vaft/vaft.user.js', 'vaft/vaft-ublock-origin.js'],
    ['vaft/vaft_testing.user.js', 'vaft/vaft-testing-ublock-origin.js'],
    ['video-swap-new/video-swap-new.user.js', 'video-swap-new/video-swap-new-ublock-origin.js']
]) {
    test(pair[0] + ' matches its uBlock runtime functions and worker', () => {
        const [left, right] = pair.map(readScript);
        const functions = source => new Map(scriptNodes(source).filter(node => node.type === 'FunctionDeclaration').map(node => [node.id.name, node]));
        const leftFunctions = functions(left);
        const rightFunctions = functions(right);
        assert.deepEqual([...leftFunctions.keys()].sort(), [...rightFunctions.keys()].sort());
        for (const [name, node] of leftFunctions) {
            assert.equal(canonical(node), canonical(rightFunctions.get(name)), name + ' differs between variants');
        }
        assert.equal(canonical(acorn.parse(serializedWorker(left), { ecmaVersion: 2022 })), canonical(acorn.parse(serializedWorker(right), { ecmaVersion: 2022 })));
        const version = source => /const ourTwitchAdSolutionsVersion = (\d+)/.exec(source)[1];
        assert.equal(version(left), version(right));
    });
}
