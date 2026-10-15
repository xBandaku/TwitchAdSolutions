const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readScript, scriptNodes } = require('./scripts');

const files = ['vaft/vaft.user.js', 'vaft/vaft_testing.user.js'];
const clean = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:100\n#EXTINF:2.000,live\nhttps://fixture.invalid/live.ts\n';

function registerStream(context, values = {}) {
    const url = 'https://fixture.invalid/native.m3u8';
    const stream = context.createStreamInfo('fixture', '', '');
    Object.assign(stream, values);
    stream.Urls[url] = { Resolution: '1920x1080', FrameRate: 60, Codecs: 'avc1.4d4028' };
    context.StreamInfosByUrl[url] = stream;
    context.StreamInfos.fixture = stream;
    return { url, stream };
}

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
    test(file + ' times out backup headers and bodies and rejects invalid playlists', async () => {
        const timers = new Map();
        let id = 0;
        const { context } = harness(file, {
            setTimeout(callback, delay) { timers.set(++id, { callback, delay }); return id; },
            clearTimeout(timer) { timers.delete(timer); }
        });
        for (const body of [false, true]) {
            const pending = context.fetchPlaylist('https://fixture.invalid/backup', async (url, { signal }) => {
                const hang = () => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
                return body ? { status: 200, text: hang } : hang();
            });
            await new Promise(setImmediate);
            assert.equal(timers.size, 1);
            const timer = [...timers.values()][0];
            assert.equal(timer.delay, 4000);
            timer.callback();
            assert.equal(await pending, null);
            assert.equal(timers.size, 0);
        }
        for (const text of ['<html>error</html>', '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=123\nhttps://fixture.invalid/variant']) {
            assert.equal(await context.fetchPlaylist('https://fixture.invalid/backup', async () => new Response(text), 4000, true), null);
        }
        assert.match(await context.fetchPlaylist('https://fixture.invalid/backup', async () => new Response(clean), 4000, true), /#EXTINF:/);
        assert.equal(timers.size, 0);
    });

    test(file + ' bounds a backup search and backs off failed searches', async () => {
        let now = 100000, tokens = 0;
        const { context } = harness(file, { Date: class extends Date { static now() { return now; } } });
        const { url, stream } = registerStream(context, { IsShowingAd: true, HasConfirmedAdAttrs: true });
        context.getAccessToken = async (channel, type, timeout) => {
            tokens++;
            assert.ok(timeout > 0 && timeout <= 4000);
            now += timeout;
            throw new Error('fixture timeout');
        };
        const marked = clean.replace('#EXT-X-TARGETDURATION', '#EXT-X-DATERANGE:CLASS="twitch-trigger"\n#EXT-X-TARGETDURATION');
        await context.processM3U8(url, marked, async () => { throw new Error('unexpected fetch'); });
        assert.equal(now, 108000);
        assert.equal(tokens, 2);
        assert.equal(stream.BackupRetryAt, 111000);
        await context.processM3U8(url, marked, async () => { throw new Error('unexpected fetch'); });
        assert.equal(tokens, 2);
        now = 111001;
        await context.processM3U8(url, marked, async () => { throw new Error('unexpected fetch'); });
        assert.ok(tokens > 2);
    });

    test(file + ' processes query, v2 and relative media URLs from master playlists', async () => {
        for (const uri of ['https://fixture.invalid/index.m3u8?token=fixture', 'https://fixture.invalid/v1/chunked/stream', '../fixture/chunked?token=fixture']) {
            const masterUrl = 'https://usher.ttvnw.net/api/v2/channel/hls/fixture.m3u8?token=fixture';
            const mediaUrl = new URL(uri, masterUrl).href;
            const master = '#EXTM3U\r\n#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,FRAME-RATE=60,CODECS="avc1.4d4028"\r\n' + uri + '\r\n';
            const calls = [], processed = [];
            const { context } = harness(file, { fetch: async (input, options) => {
                const url = input instanceof Request ? input.url : String(input);
                calls.push({ input, options });
                return new Response(url === masterUrl ? master : clean);
            } });
            context.processM3U8 = async (url, text) => { processed.push(url); return text + '#fixture-processed\n'; };
            context.hookWorkerFetch();
            await context.fetch(masterUrl);
            assert.equal(context.StreamInfos.fixture.ResolutionList.length, 1);
            assert.equal(context.StreamInfos.fixture.ResolutionList[0].Url, mediaUrl);
            const controller = new AbortController();
            const request = new Request(mediaUrl, { headers: { 'X-Fixture': 'preserved' }, signal: controller.signal });
            assert.match(await (await context.fetch(request)).text(), /#fixture-processed/);
            assert.equal(calls.at(-1).input.headers.get('X-Fixture'), 'preserved');
            controller.abort();
            assert.equal(calls.at(-1).input.signal.aborted, true);
            await context.fetch(new URL(mediaUrl));
            await context.fetch(masterUrl);
            assert.equal(context.StreamInfos.fixture.ResolutionList.length, 1);
            assert.deepEqual(processed, [mediaUrl, mediaUrl]);
            assert.ok(calls.every(call => call.input !== undefined));
        }
    });

    test(file + ' rejects media and master playlist failures', async () => {
        for (const url of ['https://fixture.invalid/live.m3u8', 'https://usher.ttvnw.net/api/channel/hls/fixture.m3u8?token=fixture']) {
            const bodyError = new Error('fixture body failed');
            const { context } = harness(file, { fetch: async () => ({ status: 200, text: async () => { throw bodyError; } }) });
            context.hookWorkerFetch();
            await assert.rejects(context.fetch(url), bodyError);
        }
        const { context } = harness(file, { fetch: async () => new Response(clean) });
        context.processM3U8 = async () => { throw new Error('fixture parser failed'); };
        context.hookWorkerFetch();
        await assert.rejects(context.fetch('https://fixture.invalid/live.m3u8'), /fixture parser failed/);
        const response = new Response('unavailable', { status: 503 });
        const failed = harness(file, { fetch: async () => response }).context;
        failed.hookWorkerFetch();
        assert.equal(await failed.fetch('https://fixture.invalid/live.m3u8'), response);
    });

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
