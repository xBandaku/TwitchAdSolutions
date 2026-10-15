const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');
const acorn = require('acorn');
const { root, scripts, readScript, scriptNodes, serializedWorker, createScriptContext } = require('./scripts');

const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).trim().split(/\r?\n/);
const canonical = node => JSON.stringify(node, function(key, value) {
    if (['start', 'end', 'raw'].includes(key)) return undefined;
    // The parsed worker is compared separately because template comments are string values.
    if (this.type === 'VariableDeclarator' && this.id.name === 'newBlobStr' && key === 'init') return { type: 'SerializedWorker' };
    return value;
});

function braveHarness(transport) {
    const timers = new Map();
    let timerId = 0;
    const window = { frameElement: null, fetch: async () => new Response('{"errors":[{"message":"fixture rejection"}]}') };
    const context = vm.createContext({
        window, document: { location: new URL('https://www.twitch.tv/channel') },
        navigator: { userAgent: 'Chrome/156.0 Windows' }, console: { log() {} },
        URL, Request, Response, Headers, DOMException, GM_xmlHttpRequest: transport,
        setTimeout(callback, delay) { timers.set(++timerId, { callback, delay }); return timerId; },
        clearTimeout(id) { timers.delete(id); }
    });
    return { window, context, timers, load: file => vm.runInContext(readScript(file), context) };
}

for (const userscriptFirst of [false, true]) {
    test('Brave retry works once with both helpers, userscript first=' + userscriptFirst, async () => {
        const calls = [];
        const fixture = braveHarness(options => {
            calls.push(options);
            queueMicrotask(() => options.onload({ status: 200, responseText: '{"data":{"fixture":true}}' }));
            return { abort() {} };
        });
        const files = ['vaft/twitch-brave-fix.user.js', 'vaft/twitch-brave-fix-ublock-origin.js'];
        if (!userscriptFirst) files.reverse();
        files.forEach(fixture.load);
        files.forEach(fixture.load);
        const response = await fixture.window.fetch('https://gql.twitch.tv/gql');
        assert.deepEqual(await response.json(), { data: { fixture: true } });
        assert.equal(calls.length, 1);
        assert.equal(fixture.timers.size, 0);
    });
}

for (const requestInput of [false, true]) {
    test('Brave retry cancels the manager transport, Request input=' + requestInput, async () => {
        let started, aborted = 0;
        const ready = new Promise(resolve => { started = resolve; });
        const fixture = braveHarness(options => {
            started();
            return { abort() { aborted++; options.onabort(); } };
        });
        fixture.load('vaft/twitch-brave-fix.user.js');
        const controller = new AbortController();
        const url = 'https://gql.twitch.tv/gql';
        const result = requestInput
            ? fixture.window.fetch(new Request(url, { signal: controller.signal }))
            : fixture.window.fetch(url, { signal: controller.signal });
        await ready;
        controller.abort();
        await assert.rejects(result, { name: 'AbortError' });
        assert.equal(aborted, 1);
        assert.equal(fixture.timers.size, 0);
    });
}

test('Brave retry times out even when the manager sends no callback', async () => {
    let started, aborted = 0;
    const ready = new Promise(resolve => { started = resolve; });
    const fixture = braveHarness(options => {
        assert.equal(options.timeout, 15000);
        started();
        return { abort() { aborted++; options.onabort(); } };
    });
    fixture.load('vaft/twitch-brave-fix.user.js');
    const result = fixture.window.fetch('https://gql.twitch.tv/gql');
    await ready;
    [...fixture.timers.values()][0].callback();
    assert.deepEqual(await (await result).json(), { errors: [{ message: 'fixture rejection' }] });
    assert.equal(aborted, 1);
    assert.equal(fixture.timers.size, 0);
});

test('Brave retry handles a rejected promise from a modern manager', async () => {
    const fixture = braveHarness(() => Promise.reject(new Error('fixture transport failure')));
    fixture.load('vaft/twitch-brave-fix.user.js');
    assert.deepEqual(await (await fixture.window.fetch('https://gql.twitch.tv/gql')).json(), { errors: [{ message: 'fixture rejection' }] });
    assert.equal(fixture.timers.size, 0);
});

for (const file of ['video-swap-new/video-swap-new.user.js', 'video-swap-new/video-swap-new-ublock-origin.js']) {
    test(file + ' forwards GQL calls with omitted options and standard header formats', async () => {
        const calls = [], updates = [];
        const window = { fetch: async (...args) => { calls.push(args); return new Response('{}'); } };
        const context = createScriptContext(readScript(file), {
            window, URL, Request, Response, Headers, console: { log() {} },
            maskAsNative: fn => fn
        });
        context.postTwitchWorkerMessage = (...args) => updates.push(args);
        context.hookFetch();
        const url = 'https://gql.twitch.tv/gql';
        await window.fetch(url);
        await window.fetch(url, { method: 'POST', body: '{}' });
        for (const headers of [
            { 'x-device-id': 'fixture', authorization: 'OAuth fixture' },
            new Headers({ 'X-Device-Id': 'fixture', Authorization: 'OAuth fixture' }),
            [['X-Device-Id', 'fixture'], ['Authorization', 'OAuth fixture']]
        ]) {
            context.gql_device_id = null;
            await window.fetch(new URL(url), { headers });
            assert.equal(context.gql_device_id, 'fixture');
        }
        const request = new Request(url, { method: 'POST', headers: { 'Client-Integrity': 'fixture' }, body: '{}' });
        await window.fetch(request);
        assert.equal(context.ClientIntegrityHeader, 'fixture');
        assert.equal(calls.at(-1)[0], request);
        assert.equal(request.bodyUsed, false);
        assert.ok(updates.some(([key]) => key === 'UpdateAuthorizationHeader'));
        await window.fetch(url, { method: 'POST', body: '{"operationName":"PlaybackAccessToken","variables":{"playerType":"site"}}' });
        assert.equal(JSON.parse(calls.at(-1)[1].body).variables.playerType, context.OPT_FORCE_ACCESS_TOKEN_PLAYER_TYPE);
    });

    test(file + ' keeps the token relay timeout active while reading the body', async () => {
        let timer, cleared = false, reading;
        const ready = new Promise(resolve => { reading = resolve; });
        const context = createScriptContext(readScript(file), {
            AbortController,
            setTimeout(callback, delay) { assert.equal(delay, 5000); timer = callback; return 1; },
            clearTimeout() { cleared = true; },
            window: { realFetch: async (url, { signal }) => ({
                text: () => new Promise((resolve, reject) => {
                    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
                    reading();
                })
            }) }
        });
        const result = context.handleWorkerFetchRequest({ id: 'fixture', url: 'https://gql.twitch.tv/gql', options: {} });
        await ready;
        assert.equal(cleared, false);
        timer();
        assert.equal((await result).error, 'GQL fetch timeout (5s)');
        assert.equal(cleared, true);
    });
}

test('the script inventory includes every installable variant', () => {
    const installable = files.filter(file => /(?:\.user\.js|ublock-origin[^/]*\.js)$/.test(file));
    assert.deepEqual(scripts.map(script => script.file).sort(), installable.sort());
});

for (const { file } of scripts.filter(script => script.file.includes('brave-fix'))) {
    test(file + ' only intercepts the intended HTTPS Twitch endpoints', () => {
        const source = readScript(file);
        const node = scriptNodes(source).find(node => node.type === 'FunctionDeclaration' && node.id.name === 'isInterceptable');
        const context = vm.createContext({ URL, document: { location: { href: 'https://www.twitch.tv/channel' } } });
        vm.runInContext(source.slice(node.start, node.end), context);
        for (const url of [
            'https://gql.twitch.tv/gql',
            'https://gql.twitch.tv/gql?operation=PlaybackAccessToken',
            'https://gql.twitch.tv:443/integrity',
            'https://passport.twitch.tv/integrity',
            '//passport.twitch.tv/integrity'
        ]) {
            assert.equal(context.isInterceptable(url), true, url);
        }
        for (const url of [
            'http://gql.twitch.tv/gql',
            'https://gql.twitch.tv:8443/gql',
            'https://gql.twitch.tv.attacker.example/gql',
            'https://attacker.example/gql.twitch.tv/gql',
            'https://attacker.example/?next=https://passport.twitch.tv/integrity',
            'https://gql.twitch.tv@attacker.example/gql',
            'https://user:password@gql.twitch.tv/gql',
            'https://gql.twitch.tv/gql-extra',
            'https://passport.twitch.tv/gql',
            '/gql',
            'https://[',
            null
        ]) {
            assert.equal(context.isInterceptable(url), false, String(url));
        }
    });
}

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
