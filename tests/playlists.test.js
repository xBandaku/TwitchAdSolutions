const test = require('node:test');
const assert = require('node:assert/strict');
const { readScript, createScriptContext } = require('./scripts');

const files = ['vaft/vaft.user.js', 'vaft/vaft-ublock-origin.js',
    'video-swap-new/video-swap-new.user.js', 'video-swap-new/video-swap-new-ublock-origin.js'];
const playlist = (sequence, segments) => '#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:'
    + sequence + '\n' + segments.map(([kind, url]) => '#EXTINF:2,' + kind + '\n' + url + '\n').join('');

for (const file of files) {
    test(file + ' restores original sequence numbers without retaining ad media entries', () => {
        for (const count of [2, 8]) {
            const context = createScriptContext(readScript(file), { console: { log() {} }, postMessage() {} });
            const stream = context.createStreamInfo('fixture', '', '');
            const segments = [['ad', 'https://fixture.invalid/ad100.ts'],
                ...Array.from({ length: count }, (_, i) => ['live', 'https://fixture.invalid/live' + (101 + i) + '.ts'])];
            context.stripAdSegments(playlist(100, segments), false, stream);
            const recovery = context.stripAdSegments(playlist(200, [['ad', 'https://fixture.invalid/ad200.ts'],
                ['ad', 'https://fixture.invalid/ad201.ts']]), false, stream);
            const expected = segments.slice(-Math.min(count, 6)).map(([, url]) => url);
            const actual = recovery.split('\n').filter(line => line && !line.startsWith('#'));
            assert.deepEqual(actual, expected);
            assert.equal(Number(recovery.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/)[1]), 101 + Math.max(0, count - 6));
            assert.equal((recovery.match(/#EXTINF:/g) || []).length, expected.length);
            assert.ok(context.AdSegmentCache.has('https://fixture.invalid/ad200.ts'));
        }
    });

    test(file + ' does not collapse ad gaps or replace cached live metadata with ad metadata', () => {
        const context = createScriptContext(readScript(file), { console: { log() {} }, postMessage() {} });
        const stream = context.createStreamInfo('fixture', '', '');
        const mixed = playlist(100, [['live', 'https://fixture.invalid/live100.ts'],
            ['ad', 'https://fixture.invalid/ad101.ts'], ['live', 'https://fixture.invalid/live102.ts'],
            ['live', 'https://fixture.invalid/live103.ts']])
            .replace('#EXTINF:2,live\nhttps://fixture.invalid/live102.ts',
                '#EXT-X-DISCONTINUITY\n#EXT-X-KEY:METHOD=AES-128,URI="https://fixture.invalid/live.key"\n'
                + '#EXT-X-MAP:URI="https://fixture.invalid/live-init.mp4"\n'
                + '#EXT-X-PROGRAM-DATE-TIME:2026-10-15T12:00:00Z\n#EXTINF:2,live\nhttps://fixture.invalid/live102.ts');
        context.stripAdSegments(mixed, false, stream);
        const ads = playlist(200, [['ad', 'https://fixture.invalid/ad200.ts']])
            .replace('#EXTINF:', '#EXT-X-KEY:METHOD=AES-128,URI="https://fixture.invalid/ad.key"\n#EXTINF:');
        const recovery = context.stripAdSegments(ads, false, stream);
        assert.match(recovery, /#EXT-X-MEDIA-SEQUENCE:102\n/);
        assert.match(recovery, /#EXT-X-DISCONTINUITY\n/);
        assert.match(recovery, /URI="https:\/\/fixture.invalid\/live.key"/);
        assert.match(recovery, /#EXT-X-MAP:URI="https:\/\/fixture.invalid\/live-init.mp4"/);
        assert.match(recovery, /#EXT-X-PROGRAM-DATE-TIME:2026-10-15T12:00:00Z/);
        assert.ok(!recovery.includes('live100.ts'));
        assert.ok(!recovery.includes('ad.key'));
        assert.ok(!recovery.includes('ad200.ts'));
    });
}

for (const file of [...files, 'strip/strip.user.js']) {
    test(file + ' resolves media and inline URLs against the final playlist location', () => {
        const context = createScriptContext(readScript(file), { URL });
        const source = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="../key.bin"\n#EXT-X-MAP:URI="init.mp4"\n'
            + '#EXT-X-PART:DURATION=0.5,URI="part.ts"\n#EXT-X-PRELOAD-HINT:TYPE=PART,URI="next.ts"\n'
            + '#EXTINF:2,ad\n./ad.ts?token=fixture\n#EXT-X-TWITCH-PREFETCH:../future.ts\n';
        const result = context.resolvePlaylistUrls(source, 'https://cdn.invalid/redirected/channel/index.m3u8');
        for (const url of ['https://cdn.invalid/redirected/key.bin', 'https://cdn.invalid/redirected/channel/init.mp4',
            'https://cdn.invalid/redirected/channel/part.ts', 'https://cdn.invalid/redirected/channel/next.ts',
            'https://cdn.invalid/redirected/channel/ad.ts?token=fixture', 'https://cdn.invalid/redirected/future.ts']) {
            assert.ok(result.includes(url), url);
        }
    });
}
