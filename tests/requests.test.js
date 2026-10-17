const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { readScript, createScriptContext } = require('./scripts');

const mainFiles = ['vaft/vaft.user.js', 'vaft/vaft-ublock-origin.js',
    'video-swap-new/video-swap-new.user.js', 'video-swap-new/video-swap-new-ublock-origin.js'];
function harness(file, bindings = {}) {
    return createScriptContext(readScript(file), {
        console: { log() {}, error() {} }, URL, Request, Response, Headers, Blob,
        Uint8Array, atob, AbortController, DOMException, setTimeout, clearTimeout, postMessage() {}, ...bindings
    });
}

for (const file of mainFiles.filter(file => file.startsWith('video-swap-new'))) {
    test('synthetic resilience: query playlist reaches processor in ' + file, async () => {
        const context = harness(file, { fetch: async () => new Response('#EXTM3U\n') });
        context.processM3U8 = async () => 'processed';
        context.hookWorkerFetch();
        const result = await context.fetch('https://cdn.invalid/live.m3u8?token=fixture');
        assert.equal(await result.text(), 'processed', 'query playlist bypassed processor');
        context.StreamInfosByUrl['https://cdn.invalid/opaque?token=fixture'] = {};
        assert.equal(await (await context.fetch('https://cdn.invalid/opaque?token=fixture')).text(), 'processed');
    });
}

for (const file of mainFiles.filter(file => file.startsWith('vaft'))) {
    test('synthetic resilience: redirected master resolves all URI forms in ' + file, async () => {
        const master = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="audio",URI="audio/index.m3u8"\n'
            + '#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720,CODECS="avc1.4d4028"\nvideo/index.m3u8\n';
        const context = harness(file, { fetch: async () => {
            const response = new Response(master);
            Object.defineProperty(response, 'url', { value: 'https://cdn.invalid/redirected/master.m3u8' });
            return response;
        } });
        context.hookWorkerFetch();
        const result = await (await context.fetch('https://usher.ttvnw.net/api/v2/channel/hls/fixture.m3u8')).text();
        assert.ok(result.includes('https://cdn.invalid/redirected/video/index.m3u8'), 'wrong redirected video base');
        assert.ok(result.includes('URI="https://cdn.invalid/redirected/audio/index.m3u8"'), 'unresolved audio group');
    });

    test('synthetic resilience: drift stops on the original element after replacement in ' + file, () => {
        const callbacks = [], timers = new Map();
        const original = { playbackRate: 1.5 };
        const replacement = { playbackRate: 1.75, buffered: { length: 1, end: () => 11 }, currentTime: 10 };
        const context = harness(file, {
            driftCatchUpInterval: null, driftCatchUpTimeout: null, driftCorrectionStop: null,
            setInterval(fn) { callbacks.push(fn); return 1; }, clearInterval() {},
            setTimeout(fn) { timers.set(1, fn); return 1; }, clearTimeout(id) { timers.delete(id); }
        });
        context.getPlayerVideoElement = () => replacement;
        context.startDriftCorrection(original);
        callbacks[0]();
        assert.equal(replacement.playbackRate, 1.75, 'drift changed the replacement element');
        assert.equal(original.playbackRate, 1.5, 'original speed was not restored');
        assert.equal(timers.size, 0);
    });
}

for (const file of mainFiles) {
    test('synthetic resilience: picture-in-picture batch preserves other operations in ' + file, async () => {
        const calls = [];
        const window = { fetch: async (...args) => { calls.push(args); return new Response('{}'); } };
        const context = harness(file, { window });
        context.postTwitchWorkerMessage = () => {};
        context.hookFetch();
        const other = { operationName: 'OtherOperation', variables: { playerType: 'keep-me' } };
        await window.fetch('https://gql.twitch.tv/gql', { method: 'POST', body: JSON.stringify([
            { operationName: 'PlaybackAccessToken', variables: { playerType: 'picture-by-picture' } }, other
        ]) });
        assert.notEqual(calls[0][1].body, '', 'entire GraphQL batch erased');
        const body = JSON.parse(calls[0][1].body);
        assert.deepEqual(body[1], other);
        assert.notEqual(body[0].variables.playerType, 'picture-by-picture');
    });

    test('synthetic resilience: unrelated host cannot overwrite GQL headers in ' + file, async () => {
        const window = { fetch: async () => new Response('{}') };
        const context = harness(file, { window });
        context.postTwitchWorkerMessage = () => {};
        context.hookFetch();
        context.AuthorizationHeader = 'OAuth twitch';
        for (const url of ['https://example.invalid/pixel?gql=true', 'https://gql.twitch.tv.evil.invalid/gql',
            'https://gql.twitch.tv/unrelated', 'https://user:pass@gql.twitch.tv/gql', 'http://gql.twitch.tv/gql']) {
            await window.fetch(url, { headers: { Authorization: 'Bearer unrelated' } });
            assert.equal(context.AuthorizationHeader, 'OAuth twitch', 'unrelated authorization captured');
        }
    });
}

test('synthetic resilience: strip forwards GQL fetch without options', async () => {
    const calls = [];
    const window = { fetch: async (...args) => { calls.push(args); return new Response('{}'); } };
    const context = harness('strip/strip.user.js', { window });
    context.hookFetch();
    await window.fetch('https://gql.twitch.tv/gql');
    assert.equal(calls.length, 1);
});

for (const file of [...mainFiles.filter(file => file.startsWith('video-swap-new')), 'strip/strip.user.js']) {
    for (const master of file.startsWith('video-swap-new') ? [false, true] : [false]) {
        test('synthetic resilience: interrupted playlist body rejects caller in ' + file + ', master=' + master, () => {
            // Isolate unhandled rejections so a broken hook cannot hang the test runner.
            const program = `
                const {readScript,createScriptContext}=require('./tests/scripts');
                process.on('unhandledRejection',()=>{});
                const c=createScriptContext(readScript(${JSON.stringify(file)}),{
                    console:{log(){}},URL,Request,Response,Headers,Blob,Uint8Array,atob,
                    setTimeout,clearTimeout,postMessage(){},
                    fetch:async()=>({status:200,text:async()=>{throw new Error('interrupted')}})
                });
                const url=${JSON.stringify(master ? 'https://usher.ttvnw.net/api/v2/channel/hls/fixture.m3u8?token=fixture' : 'https://cdn.invalid/live.m3u8')};
                if(c.M3U8Whitelist)c.M3U8Whitelist.add(url);
                c.hookWorkerFetch();
                Promise.race([c.fetch(url).then(()=> 'resolved',e=>'rejected:'+e.message),
                    new Promise(r=>setTimeout(()=>r('pending'),100))]).then(value=>process.stdout.write(value));
            `;
            const result = execFileSync(process.execPath, ['-e', program], { encoding: 'utf8', timeout: 5000 });
            assert.equal(result, 'rejected:interrupted', 'interrupted body left caller pending');
        });
    }
}
