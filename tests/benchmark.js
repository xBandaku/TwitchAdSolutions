const { performance } = require('node:perf_hooks');
const { readScript, createScriptContext } = require('./scripts');

const CLEAN_PLAYLIST = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:48201
#EXTINF:2.000,live
https://video-edge-abc.fra02.abs.hls.ttvnw.net/v1/segment/CpUE_seg48201.ts
#EXTINF:2.000,live
https://video-edge-abc.fra02.abs.hls.ttvnw.net/v1/segment/CpUE_seg48202.ts
#EXTINF:2.000,live
https://video-edge-abc.fra02.abs.hls.ttvnw.net/v1/segment/CpUE_seg48203.ts
#EXTINF:2.000,live
https://video-edge-abc.fra02.abs.hls.ttvnw.net/v1/segment/CpUE_seg48204.ts
#EXTINF:2.000,live
https://video-edge-abc.fra02.abs.hls.ttvnw.net/v1/segment/CpUE_seg48205.ts
#EXTINF:2.000,live
https://video-edge-abc.fra02.abs.hls.ttvnw.net/v1/segment/CpUE_seg48206.ts`;

const AD_PLAYLIST = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:48201
#EXT-X-DATERANGE:CLASS="twitch-stitched-ad",ID="ad-1",START-DATE="2026-04-08T12:00:00Z",DURATION=30.0
#EXT-X-DATERANGE:CLASS="twitch-ad-quartile",ID="q1",START-DATE="2026-04-08T12:00:00Z"
X-TV-TWITCH-AD-URL="https://ad-track.twitch.tv/imp1"
X-TV-TWITCH-AD-CLICK-TRACKING-URL="https://ad-track.twitch.tv/click1"
X-TV-TWITCH-AD-QUARTILE-URLS="https://ad-track.twitch.tv/q1"
#EXTINF:2.000,
https://video-edge-abc.fra02.abs.hls.ttvnw.net/v1/segment/stitched_ad_seg1.ts
#EXTINF:2.000,
https://video-edge-abc.fra02.abs.hls.ttvnw.net/v1/segment/stitched_ad_seg2.ts
#EXTINF:2.000,
https://video-edge-abc.fra02.abs.hls.ttvnw.net/v1/segment/stitched_ad_seg3.ts
#EXTINF:2.000,
https://video-edge-abc.fra02.abs.hls.ttvnw.net/v1/segment/stitched_ad_seg4.ts
#EXTINF:2.000,live
https://video-edge-abc.fra02.abs.hls.ttvnw.net/v1/segment/CpUE_seg48205.ts
#EXTINF:2.000,live
https://video-edge-abc.fra02.abs.hls.ttvnw.net/v1/segment/CpUE_seg48206.ts
#EXT-X-TWITCH-PREFETCH:https://video-edge-abc.fra02.abs.hls.ttvnw.net/v1/segment/CpUE_seg48207.ts
#EXT-X-TWITCH-PREFETCH:https://video-edge-abc.fra02.abs.hls.ttvnw.net/v1/segment/CpUE_seg48208.ts`;

const SCTE35_PLAYLIST = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:48201
#EXT-X-CUE-OUT:DURATION=30
SCTE35-OUT=0xFC301600000000000000FFF0140500000000010000000000000000
#EXTINF:2.000,
https://video-edge-abc.fra02.abs.hls.ttvnw.net/v1/segment/stitched_ad_seg1.ts
#EXTINF:2.000,
https://video-edge-abc.fra02.abs.hls.ttvnw.net/v1/segment/stitched_ad_seg2.ts
#EXTINF:2.000,
https://video-edge-abc.fra02.abs.hls.ttvnw.net/v1/segment/stitched_ad_seg3.ts
#EXT-X-CUE-IN
#EXTINF:2.000,live
https://video-edge-abc.fra02.abs.hls.ttvnw.net/v1/segment/CpUE_seg48204.ts
#EXTINF:2.000,live
https://video-edge-abc.fra02.abs.hls.ttvnw.net/v1/segment/CpUE_seg48205.ts`;

const ENCODINGS_M3U8 = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=6000000,CODECS="avc1.64002A",RESOLUTION=1920x1080,FRAME-RATE=60.000
https://video-weaver.fra02.hls.ttvnw.net/v1/playlist/source.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3000000,CODECS="avc1.4D401F",RESOLUTION=1280x720,FRAME-RATE=30.000
https://video-weaver.fra02.hls.ttvnw.net/v1/playlist/720p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1500000,CODECS="avc1.4D401E",RESOLUTION=852x480,FRAME-RATE=30.000
https://video-weaver.fra02.hls.ttvnw.net/v1/playlist/480p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=700000,CODECS="avc1.4D4015",RESOLUTION=640x360,FRAME-RATE=30.000
https://video-weaver.fra02.hls.ttvnw.net/v1/playlist/360p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=400000,CODECS="avc1.4D400C",RESOLUTION=284x160,FRAME-RATE=30.000
https://video-weaver.fra02.hls.ttvnw.net/v1/playlist/160p.m3u8`;

const PARSE_ATTR_INPUT = 'BANDWIDTH=6000000,CODECS="avc1.64002A",RESOLUTION=1920x1080,FRAME-RATE=60.000';
const PARSE_ATTR_TAG = '#EXT-X-STREAM-INF:' + PARSE_ATTR_INPUT;

const source = readScript('vaft/vaft.user.js');
const runtime = createScriptContext(source, { console: { log() {} } });

function stripPlaylist(playlist) {
    runtime.AdSegmentCache.clear();
    runtime.AllSegmentsAreAdSegments = false;
    return runtime.stripAdSegments(playlist, false, runtime.createStreamInfo('benchmark', '', ''));
}

function bench(name, run, iterations = 10000) {
    for (let index = 0; index < 1000; index++) run();
    if (global.gc) global.gc();
    const before = process.memoryUsage().heapUsed;
    const start = performance.now();
    for (let index = 0; index < iterations; index++) run();
    const elapsed = performance.now() - start;
    if (global.gc) global.gc();
    const heapDelta = (process.memoryUsage().heapUsed - before) / 1024;
    console.log(name + ': ' + elapsed.toFixed(2) + 'ms, ' + Math.round(iterations / elapsed * 1000) + ' ops/s, heap delta ' + heapDelta.toFixed(1) + ' KiB');
}

console.log('vaft v' + /@version\s+(\S+)/.exec(source)[1] + ', Node ' + process.version);
console.log('Strip measurements include a fresh stream and cache reset per iteration.');
console.log('Use node --expose-gc tests/benchmark.js for heap measurements after garbage collection.');

bench('hasAdTags, clean', () => runtime.hasAdTags(CLEAN_PLAYLIST));
bench('hasAdTags, ads', () => runtime.hasAdTags(AD_PLAYLIST));
bench('stripAdSegments, clean', () => stripPlaylist(CLEAN_PLAYLIST));
bench('stripAdSegments, ads', () => stripPlaylist(AD_PLAYLIST));
bench('stripAdSegments, SCTE-35', () => stripPlaylist(SCTE35_PLAYLIST));
bench('parseAttributes, attributes', () => runtime.parseAttributes(PARSE_ATTR_INPUT));
bench('parseAttributes, HLS tag', () => runtime.parseAttributes(PARSE_ATTR_TAG));
bench('parseAttributes, null', () => runtime.parseAttributes(null));
bench('getStreamUrlForResolution', () => runtime.getStreamUrlForResolution(ENCODINGS_M3U8, {
    Resolution: '1920x1080', FrameRate: 60, Codecs: 'avc1.64002A'
}));
