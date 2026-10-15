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
    context.ActiveStreamInfo = stream;
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
    test(file + ' ranks backup codec compatibility ahead of resolution', () => {
        const { context } = harness(file);
        const variant = (codec, resolution, name) => '#EXT-X-STREAM-INF:' + (codec ? 'CODECS="' + codec + '",' : '') + 'RESOLUTION=' + resolution + ',FRAME-RATE=60,BANDWIDTH=3000000\nhttps://fixture.invalid/' + name + '\n';
        const hevc = variant('hvc1.1.6.L120', '1920x1080', 'hevc');
        const avc = variant('mp4a.40.2,avc1.4d4028', '1280x720', 'avc');
        const av1 = variant('av01.0.08M.08', '1920x1080', 'av1');
        const unknown = variant(null, '1920x1080', 'unknown');
        const resolution = { Resolution: '1920x1080', FrameRate: 60, Codecs: 'avc1.4d4028' };
        assert.equal(context.getStreamUrlForResolution('#EXTM3U\n' + hevc + unknown + av1 + avc, resolution), 'https://fixture.invalid/avc');
        assert.equal(context.getStreamUrlForResolution('#EXTM3U\n' + hevc + unknown + av1, resolution), 'https://fixture.invalid/unknown');
        assert.equal(context.getStreamUrlForResolution('#EXTM3U\n' + avc + hevc, { ...resolution, Codecs: 'hvc1.1' }), 'https://fixture.invalid/hevc');
        assert.equal(context.getStreamUrlForResolution('#EXTM3U\n' + avc + av1, { ...resolution, Codecs: 'av01.0' }), 'https://fixture.invalid/av1');
        assert.equal(context.getStreamUrlForResolution('#EXTM3U\n' + hevc, resolution), 'https://fixture.invalid/hevc');
    });

    test(file + ' uses the pre-reset freeze count for post-ad recovery', async () => {
        for (const polls of [1, 2, 9]) {
            const { context, messages } = harness(file);
            const { url, stream } = registerStream(context, {
                IsShowingAd: true, HasConfirmedAdAttrs: true, CleanPlaylistCount: 2,
                NumStrippedAdSegments: 4, TotalAllStrippedPolls: polls,
                CycleRescuedThisBreak: true, EarlyReloadCount: 0
            });
            await context.processM3U8(url, clean, null);
            assert.equal(stream.IsShowingAd, false);
            assert.equal(stream.TotalAllStrippedPolls, 0);
            assert.equal(messages.filter(message => message.key === 'ReloadPlayer').length, polls > 2 ? 1 : 0);
        }
    });

    test(file + ' confirms advancing clean playlists and bounds marker bouncing', async () => {
        let now = 100000;
        const make = () => {
            const { context } = harness(file, { Date: class extends Date { static now() { return now; } } });
            context.BackupSwapFirst = false;
            return { context, ...registerStream(context, { IsShowingAd: true, HasConfirmedAdAttrs: true }) };
        };
        const repeated = make();
        for (let poll = 0; poll < 8; poll++) {
            now += 2500;
            await repeated.context.processM3U8(repeated.url, clean, null);
        }
        assert.equal(repeated.stream.IsShowingAd, true);
        assert.equal(repeated.stream.CleanPlaylistCount, 1);
        for (const sequence of [101, 102]) {
            await repeated.context.processM3U8(repeated.url, clean.replace('SEQUENCE:100', 'SEQUENCE:' + sequence), null);
        }
        assert.equal(repeated.stream.IsShowingAd, false);
        const bounced = make();
        const start = now;
        for (let poll = 0; poll <= 6; poll++) {
            now = start + poll * 2500;
            let text = clean.replace('SEQUENCE:100', 'SEQUENCE:' + (100 + poll));
            if (poll % 2) text = text.replace('#EXT-X-TARGETDURATION', '#EXT-X-DATERANGE:CLASS="twitch-trigger"\n#EXT-X-TARGETDURATION');
            await bounced.context.processM3U8(bounced.url, text, null);
        }
        assert.equal(bounced.stream.IsShowingAd, false);
        const sustained = make();
        await sustained.context.processM3U8(sustained.url, clean, null);
        now += 13000;
        await sustained.context.processM3U8(sustained.url, clean.replace('#EXT-X-TARGETDURATION', '#EXT-X-DATERANGE:CLASS="twitch-trigger"\n#EXT-X-TARGETDURATION'), null);
        assert.equal(sustained.stream.PendingAdEndAt, 0);
        assert.equal(sustained.stream.IsShowingAd, true);
    });

    test(file + ' orders playlist state updates and discards obsolete responses', async () => {
        const { context } = harness(file);
        const { url, stream } = registerStream(context);
        const seen = [];
        let release;
        context.processStreamPlaylist = async (url, text) => {
            seen.push(text);
            if (text === 'first') await new Promise(resolve => { release = resolve; });
            if (text === 'error') throw new Error('fixture error');
            return 'processed ' + text;
        };
        const first = context.processM3U8(url, 'first', null, 1, stream);
        await new Promise(setImmediate);
        const second = context.processM3U8(url, 'second', null, 2, stream);
        assert.deepEqual(seen, ['first']);
        release();
        assert.deepEqual(await Promise.all([first, second]), ['processed first', 'processed second']);
        assert.equal(await context.processM3U8(url, 'late first', null, 1, stream), 'processed second');
        await assert.rejects(context.processM3U8(url, 'error', null, 3, stream), /fixture error/);
        assert.equal(await context.processM3U8(url, 'after error', null, 4, stream), 'processed after error');
        registerStream(context);
        const obsolete = await context.processM3U8(url, clean, null, 5, stream);
        assert.match(obsolete, /#EXTM3U/);
        assert.ok(!seen.includes(clean));
    });

    test(file + ' rejects replaced-worker and wrong-channel messages and accepts embeds', () => {
        const worker = {}, replaced = {};
        const window = { location: { href: 'https://www.twitch.tv/fixture' } };
        const { context, messages } = harness(file, { window, twitchWorkers: [worker] });
        const { stream } = registerStream(context);
        assert.equal(context.isCurrentStreamMessage(worker, { channelName: 'fixture' }), true);
        assert.equal(context.isCurrentStreamMessage(replaced, { channelName: 'fixture' }), false);
        assert.equal(context.isCurrentStreamMessage(worker, { channelName: 'old' }), false);
        window.location.href = 'https://player.twitch.tv/?channel=fixture&parent=fixture.invalid';
        assert.equal(context.isCurrentStreamMessage(worker, { channelName: 'fixture' }), true);
        context.postStreamMessage(stream, { key: 'ReloadPlayer' });
        assert.equal(messages.length, 1);
        registerStream(context);
        context.postStreamMessage(stream, { key: 'ReloadPlayer' });
        assert.equal(messages.length, 1);
    });

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
