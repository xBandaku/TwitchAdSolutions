const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readScript, scriptNodes } = require('./scripts');

const files = ['vaft/vaft.user.js', 'vaft/vaft_testing.user.js'];
const clean = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:100\n#EXTINF:2.000,live\nhttps://fixture.invalid/live.ts\n';

function harness(file, bindings = {}) {
    const source = readScript(file);
    const declarations = scriptNodes(source).filter(node => node.type === 'FunctionDeclaration');
    const messages = [];
    const context = vm.createContext({
        console: { log() {}, error() {} }, URL, Request, Response, Headers, Blob,
        AbortController, DOMException, Uint8Array, atob, setTimeout, clearTimeout,
        postMessage: message => messages.push(message),
        ...bindings
    });
    vm.runInContext(declarations.map(node => source.slice(node.start, node.end)).join('\n'), context);
    context.declareOptions(context);
    return { context, messages };
}

for (const file of files) {
    test(file + ' forwards GQL fetch inputs and captures every supported header format', async () => {
        const calls = [], updates = [];
        const window = { fetch: async (...args) => { calls.push(args); return new Response('{}'); } };
        const { context } = harness(file, { window });
        context.postTwitchWorkerMessage = (...args) => updates.push(args);
        context.hookFetch();
        await window.fetch('https://gql.twitch.tv/gql');
        await window.fetch('https://gql.twitch.tv/gql', { method: 'POST', body: '{}' });
        for (const headers of [
            { 'x-device-id': 'fixture', authorization: 'OAuth fixture' },
            new Headers({ 'X-Device-Id': 'fixture', Authorization: 'OAuth fixture' }),
            [['X-Device-Id', 'fixture'], ['Authorization', 'OAuth fixture']]
        ]) {
            context.GQLDeviceID = null;
            await window.fetch(new URL('https://gql.twitch.tv/gql'), { headers });
            assert.equal(context.GQLDeviceID, 'fixture');
        }
        const request = new Request('https://gql.twitch.tv/gql', {
            method: 'POST', headers: { 'Client-Session-Id': 'session' }, body: '{}'
        });
        await window.fetch(request);
        assert.equal(context.ClientSession, 'session');
        assert.equal(calls.length, 6);
        assert.equal(calls.at(-1)[0], request);
        assert.equal(request.bodyUsed, false);
        assert.ok(updates.some(([key]) => key === 'UpdateAuthorizationHeader'));
        const body = JSON.stringify({ operationName: 'PlaybackAccessToken', variables: { playerType: 'site' } });
        await window.fetch('https://gql.twitch.tv/gql', { method: 'POST', body });
        assert.equal(JSON.parse(calls.at(-1)[1].body).variables.playerType, context.ForceAccessTokenPlayerType);
    });
}
