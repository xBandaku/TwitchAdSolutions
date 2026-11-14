const test = require('node:test');
const assert = require('node:assert/strict');
const { scripts, readScript, createScriptContext } = require('./scripts');

for (const { file } of scripts.filter(({ file }) => /^(vaft\/vaft|video-swap-new\/video-swap-new)/.test(file))) {
    function fixture() {
        let now = 100000;
        const context = createScriptContext(readScript(file), {
            Date: class extends Date { static now() { return now; } },
            console: { log() {} }, URL,
            postMessage() {}
        });
        function register(channel) {
            const stream = context.createStreamInfo(channel, '', '');
            const url = 'https://fixture.invalid/' + channel + '.m3u8';
            const resolution = { Resolution: '1280x720', FrameRate: 30, Codecs: 'avc1.4d4028' };
            if (stream.Urls instanceof Map || typeof stream.Urls.set === 'function') stream.Urls.set(url, resolution);
            else stream.Urls[url] = resolution;
            context.StreamInfos[channel] = stream;
            context.StreamInfosByUrl[url] = stream;
            context.ActiveStreamInfo = stream;
            return { stream, url };
        }
        return { context, register, advance(ms) { now += ms; }, now: () => now };
    }

    test('synthetic resilience: idle mapping survives pause and media-only resume in ' + file, async () => {
        const h = fixture();
        const { stream, url } = h.register('paused');
        h.advance(h.context.StreamInfoMaxAgeMs + 1);
        h.context.pruneStreamInfos();
        h.advance(h.context.StreamInfoMaxAgeMs);
        h.context.pruneStreamInfos();
        const clean = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:100\n#EXTINF:2.000,live\nhttps://fixture.invalid/live.ts\n';
        await h.context.processM3U8(url, clean, async () => { throw new Error('Unexpected backup fetch'); });
        assert.equal(stream.LastSeenAt, h.now(), 'resumed media playlist bypassed processing after idle cleanup');
        assert.equal(h.context.StreamInfosByUrl[url], stream);
        assert.equal(stream.LastCleanNativeM3U8, clean);
    });

    test('synthetic resilience: idle mapping cleanup retires abandoned channels in ' + file, () => {
        const h = fixture();
        const old = h.register('old');
        h.advance(1000);
        const current = h.register('current');
        h.advance(h.context.StreamInfoMaxAgeMs + 1);
        h.context.StreamInfos.malformed = null;
        h.context.pruneStreamInfos();
        assert.equal(h.context.StreamInfos.old, undefined);
        assert.equal(h.context.StreamInfosByUrl[old.url], undefined);
        assert.equal(h.context.StreamInfos.current, current.stream);
        assert.equal(h.context.StreamInfosByUrl[current.url], current.stream);
        assert.equal(h.context.StreamInfos.malformed, undefined);
        const next = h.register('next');
        h.context.pruneStreamInfos();
        assert.equal(h.context.StreamInfos.current, undefined);
        assert.equal(h.context.StreamInfosByUrl[current.url], undefined);
        assert.equal(h.context.StreamInfos.next, next.stream);
    });
}
