// Unit tests for TwitchAdSolutions
// Run: node tests/test.js

let passed = 0;
let failed = 0;

function assert(condition, message) {
    if (condition) {
        passed++;
    } else {
        failed++;
        console.error('FAIL: ' + message);
    }
}

function assertEq(actual, expected, message) {
    if (actual === expected) {
        passed++;
    } else {
        failed++;
        console.error('FAIL: ' + message + ' — expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
    }
}

function assertDeepEq(actual, expected, message) {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
        passed++;
    } else {
        failed++;
        console.error('FAIL: ' + message + ' — expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
    }
}

// ============================================================
// Mock globals
// ============================================================
// Narrowed per PR #120 (remove false-positive substrings) + broadened per PR #166
// (twitch-stitched prefix covers all twitch-stitched-* DATERANGE classes).
const AdSignifiers = ['stitched-ad', 'EXT-X-CUE-OUT', 'twitch-stitched', 'EXT-X-DATERANGE:CLASS="twitch-maf-ad"'];
const AdSegmentURLPatterns = ['/adsquared/', '/_404/', '/processing'];
let AdSegmentCache = new Map();
let AllSegmentsAreAdSegments = false;
let V2API = false;

const workerStringConflicts = ['twitch', 'isVariantA'];
const workerStringReinsert = ['isVariantA', 'besuper/', '${patch_url}'];

// ============================================================
// Functions under test (copied from vaft.user.js)
// ============================================================

function hasAdTags(textStr) {
    return AdSignifiers.some((s) => textStr.includes(s));
}

function getMatchedAdSignifiers(textStr) {
    return AdSignifiers.filter((s) => textStr.includes(s));
}

function parseAttributes(str) {
    if (!str) return {};
    if (str.charCodeAt(0) === 35) { // '#'
        const idx = str.indexOf(':');
        if (idx !== -1) str = str.slice(idx + 1);
    }
    return Object.fromEntries(
        str.split(/(?:^|,)((?:[^=]*)=(?:"[^"]*"|[^,]*))/)
        .filter(Boolean)
        .map(x => {
            const idx = x.indexOf('=');
            const key = x.substring(0, idx);
            const value = x.substring(idx + 1);
            const num = Number(value);
            return [key, Number.isNaN(num) ? value.startsWith('"') ? JSON.parse(value) : value : num];
        }));
}

function getServerTimeFromM3u8(encodingsM3u8) {
    if (V2API) {
        const matches = encodingsM3u8.match(/#EXT-X-SESSION-DATA:DATA-ID="SERVER-TIME",VALUE="([^"]+)"/);
        return matches && matches.length > 1 ? matches[1] : null;
    }
    const matches = encodingsM3u8.match(/SERVER-TIME="([0-9.]+)"/);
    return matches && matches.length > 1 ? matches[1] : null;
}

function replaceServerTimeInM3u8(encodingsM3u8, newServerTime) {
    if (V2API) {
        return newServerTime ? encodingsM3u8.replace(/(#EXT-X-SESSION-DATA:DATA-ID="SERVER-TIME",VALUE=")[^"]+(")/, `$1${newServerTime}$2`) : encodingsM3u8;
    }
    return newServerTime ? encodingsM3u8.replace(/(SERVER-TIME=")[0-9.]+"/, `SERVER-TIME="${newServerTime}"`) : encodingsM3u8;
}

function getStreamUrlForResolution(encodingsM3u8, resolutionInfo) {
    const encodingsLines = encodingsM3u8.split(/\r?\n/);
    const [targetWidth, targetHeight] = resolutionInfo.Resolution.split('x').map(Number);
    let matchedResolutionUrl = null;
    let matchedFrameRate = false;
    let closestResolutionUrl = null;
    let closestResolutionDifference = Infinity;
    for (let i = 0; i < encodingsLines.length - 1; i++) {
        if (encodingsLines[i].startsWith('#EXT-X-STREAM-INF') && encodingsLines[i + 1].includes('.m3u8')) {
            const attributes = parseAttributes(encodingsLines[i]);
            const resolution = attributes['RESOLUTION'];
            const frameRate = attributes['FRAME-RATE'];
            if (resolution) {
                if (resolution == resolutionInfo.Resolution && (!matchedResolutionUrl || (!matchedFrameRate && frameRate == resolutionInfo.FrameRate))) {
                    matchedResolutionUrl = encodingsLines[i + 1];
                    matchedFrameRate = frameRate == resolutionInfo.FrameRate;
                    if (matchedFrameRate) {
                        return matchedResolutionUrl;
                    }
                }
                const [width, height] = resolution.split('x').map(Number);
                const difference = Math.abs((width * height) - (targetWidth * targetHeight));
                if (difference < closestResolutionDifference) {
                    closestResolutionUrl = encodingsLines[i + 1];
                    closestResolutionDifference = difference;
                }
            }
        }
    }
    return closestResolutionUrl;
}

function stripAdSegments(textStr, stripAllSegments, streamInfo) {
    let hasStrippedAdSegments = false;
    let inCueOut = false;
    const liveSegments = [];
    const lines = textStr.split(/\r?\n/);
    const newAdUrl = 'https://twitch.tv';
    for (let i = 0; i < lines.length; i++) {
        let line = lines[i];
        if (line.includes('EXT-X-CUE-OUT')) {
            inCueOut = true;
        } else if (line.includes('EXT-X-CUE-IN')) {
            inCueOut = false;
        }
        lines[i] = line
            .replaceAll(/(X-TV-TWITCH-AD(?:-[A-Z]+)*-URLS?=")[^"]*(")/g, `$1${newAdUrl}$2`);
        if (i < lines.length - 1 && line.startsWith('#EXTINF') && (!line.includes(',live') || stripAllSegments || AllSegmentsAreAdSegments || inCueOut)) {
            const segmentUrl = lines[i + 1];
            if (!AdSegmentCache.has(segmentUrl)) {
                streamInfo.NumStrippedAdSegments++;
            }
            AdSegmentCache.set(segmentUrl, Date.now());
            hasStrippedAdSegments = true;
        } else if (i < lines.length - 1 && line.startsWith('#EXTINF') && AdSegmentURLPatterns.some((p) => lines[i + 1].includes(p))) {
            AdSegmentCache.set(lines[i + 1], Date.now());
            hasStrippedAdSegments = true;
            streamInfo.NumStrippedAdSegments++;
        } else if (i < lines.length - 1 && line.startsWith('#EXTINF') && line.includes(',live')) {
            liveSegments.push({ extinf: line, url: lines[i + 1] });
        }
        if (AdSignifiers.some((s) => line.includes(s))) {
            hasStrippedAdSegments = true;
        }
    }
    if (hasStrippedAdSegments) {
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].startsWith('#EXT-X-TWITCH-PREFETCH:')) {
                lines[i] = '';
            }
        }
    } else {
        streamInfo.NumStrippedAdSegments = 0;
    }
    if (liveSegments.length > 0) {
        streamInfo.RecoverySegments = liveSegments.slice(-6);
        const seq = parseInt((textStr.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/) || [])[1]);
        if (!isNaN(seq)) {
            streamInfo.RecoveryStartSeq = seq + Math.max(0, liveSegments.length - streamInfo.RecoverySegments.length);
        }
    }
    if (hasStrippedAdSegments && liveSegments.length === 0 && streamInfo.RecoverySegments && streamInfo.RecoverySegments.length > 0) {
        if (streamInfo.RecoveryStartSeq !== undefined) {
            for (let j = 0; j < lines.length; j++) {
                if (lines[j].startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
                    lines[j] = '#EXT-X-MEDIA-SEQUENCE:' + streamInfo.RecoveryStartSeq;
                    break;
                }
            }
        }
        for (let j = 0; j < streamInfo.RecoverySegments.length; j++) {
            lines.push(streamInfo.RecoverySegments[j].extinf);
            lines.push(streamInfo.RecoverySegments[j].url);
        }
    }
    streamInfo.IsStrippingAdSegments = hasStrippedAdSegments;
    return lines.join('\n');
}

function isValidWorker(worker) {
    const workerString = worker.toString();
    const hasConflict = workerStringConflicts.some((x) => workerString.includes(x));
    const hasReinsert = workerStringReinsert.some((x) => workerString.includes(x));
    return !hasConflict || hasReinsert;
}

// ============================================================
// Test: hasAdTags
// ============================================================
console.log('--- hasAdTags ---');
assert(hasAdTags('stitched-ad-12345.ts') === true, 'detects stitched-ad');
assert(hasAdTags('#EXT-X-CUE-OUT:DURATION=30') === true, 'detects EXT-X-CUE-OUT');
assert(hasAdTags('#EXT-X-DATERANGE:CLASS="twitch-stitched-ad"') === true, 'detects twitch-stitched-ad (via prefix + stitched-ad)');
assert(hasAdTags('#EXT-X-DATERANGE:CLASS="twitch-maf-ad"') === true, 'detects twitch-maf-ad exact');
assert(hasAdTags('normal-segment-12345.ts') === false, 'clean segment returns false');
assert(hasAdTags('#EXTINF:2.000,live\nhttps://video.twitch.tv/segment.ts') === false, 'normal m3u8 returns false');
assert(hasAdTags('') === false, 'empty string returns false');
// Narrowed signifiers (removed per PR #120 to eliminate false positives): bare 'stitched', 'X-TV-TWITCH-AD', 'SCTE35-OUT'
assert(hasAdTags('stitched') === false, 'bare stitched is narrowed out (PR #120 false-positive fix)');
assert(hasAdTags('X-TV-TWITCH-AD-URL="http://example.com"') === false, 'X-TV-TWITCH-AD no longer a signifier');
assert(hasAdTags('SCTE35-OUT') === false, 'SCTE35-OUT no longer a signifier');

// ============================================================
// Test: getMatchedAdSignifiers
// ============================================================
console.log('--- getMatchedAdSignifiers ---');
assertDeepEq(getMatchedAdSignifiers('stitched-ad with #EXT-X-CUE-OUT marker'), ['stitched-ad', 'EXT-X-CUE-OUT'], 'matches multiple signifiers');
assertDeepEq(getMatchedAdSignifiers('#EXT-X-CUE-OUT:DURATION=30'), ['EXT-X-CUE-OUT'], 'matches single CUE-OUT');
assertDeepEq(getMatchedAdSignifiers('normal content'), [], 'no matches on clean content');
assertDeepEq(getMatchedAdSignifiers('#EXT-X-DATERANGE:CLASS="twitch-stitched-ad"'), ['stitched-ad', 'twitch-stitched'], 'twitch-stitched-ad hits both stitched-ad substring and twitch-stitched prefix');
// PR #166 broadened coverage via twitch-stitched prefix (catches future variants like twitch-stitched-mid, twitch-stitched-pod).
assert(hasAdTags('#EXT-X-DATERANGE:CLASS="twitch-stitched-mid"') === true, 'detects twitch-stitched-mid via prefix');
assert(hasAdTags('#EXT-X-DATERANGE:CLASS="twitch-stitched-pod"') === true, 'detects twitch-stitched-pod via prefix');
// Narrowed DATERANGE classes (no longer individually listed — not covered by twitch-stitched prefix either)
assert(hasAdTags('#EXT-X-DATERANGE:CLASS="twitch-stream-source"') === false, 'twitch-stream-source not a signifier');
assert(hasAdTags('#EXT-X-DATERANGE:CLASS="twitch-trigger"') === false, 'twitch-trigger not a signifier');
assert(hasAdTags('#EXT-X-DATERANGE:CLASS="twitch-ad-quartile"') === false, 'twitch-ad-quartile not a signifier');

// ============================================================
// Test: parseAttributes
// ============================================================
console.log('--- parseAttributes ---');
const attrs1 = parseAttributes('#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,CODECS="avc1.4D4028",FRAME-RATE=30.0');
assertEq(attrs1['RESOLUTION'], '1920x1080', 'parses resolution');
assertEq(attrs1['FRAME-RATE'], 30, 'parses frame rate as number');
assertEq(attrs1['CODECS'], 'avc1.4D4028', 'parses quoted codecs');
// BANDWIDTH is the first attribute after the colon — parseAttributes regex splits on comma-prefixed pairs
const attrs1b = parseAttributes('BANDWIDTH=6000000,RESOLUTION=1920x1080');
assertEq(attrs1b['BANDWIDTH'], 6000000, 'parses bandwidth as number when first attribute');

const attrs2 = parseAttributes('#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=852x480,CODECS="hev1.1.6.L120",FRAME-RATE=60.0');
assertEq(attrs2['RESOLUTION'], '852x480', 'parses 480p resolution');
assertEq(attrs2['CODECS'], 'hev1.1.6.L120', 'parses HEVC codec');
assertEq(attrs2['FRAME-RATE'], 60, 'parses 60fps');

// ============================================================
// Test: getServerTimeFromM3u8
// ============================================================
console.log('--- getServerTimeFromM3u8 ---');
V2API = false;
assertEq(getServerTimeFromM3u8('#EXT-X-TWITCH-ELAPSED-SECS:10.5,SERVER-TIME="1234567890.123"'), '1234567890.123', 'extracts v1 server time');
assertEq(getServerTimeFromM3u8('no server time here'), null, 'returns null when no server time');

V2API = true;
assertEq(getServerTimeFromM3u8('#EXT-X-SESSION-DATA:DATA-ID="SERVER-TIME",VALUE="9876543210.456"'), '9876543210.456', 'extracts v2 server time');
assertEq(getServerTimeFromM3u8('no server time here'), null, 'returns null for v2 when no match');
V2API = false;

// ============================================================
// Test: replaceServerTimeInM3u8
// ============================================================
console.log('--- replaceServerTimeInM3u8 ---');
V2API = false;
const m3u8WithTime = '#EXT-X-TWITCH-ELAPSED-SECS:10.5,SERVER-TIME="1234567890.123"';
assert(replaceServerTimeInM3u8(m3u8WithTime, '9999999999.000').includes('SERVER-TIME="9999999999.000"'), 'replaces v1 server time');
assertEq(replaceServerTimeInM3u8(m3u8WithTime, null), m3u8WithTime, 'returns original when newServerTime is null');

V2API = true;
const m3u8V2 = '#EXT-X-SESSION-DATA:DATA-ID="SERVER-TIME",VALUE="1234567890.123"';
assert(replaceServerTimeInM3u8(m3u8V2, '9999999999.000').includes('VALUE="9999999999.000"'), 'replaces v2 server time');
V2API = false;

// ============================================================
// Test: getStreamUrlForResolution
// ============================================================
console.log('--- getStreamUrlForResolution ---');
const encodingsM3u8 = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,CODECS="avc1.4D4028",FRAME-RATE=30.0',
    'https://video.twitch.tv/1080p30.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,CODECS="avc1.4D401F",FRAME-RATE=60.0',
    'https://video.twitch.tv/720p60.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=852x480,CODECS="avc1.4D401E",FRAME-RATE=30.0',
    'https://video.twitch.tv/480p30.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=600000,RESOLUTION=640x360,CODECS="avc1.4D401E",FRAME-RATE=30.0',
    'https://video.twitch.tv/360p30.m3u8',
].join('\n');

assertEq(
    getStreamUrlForResolution(encodingsM3u8, { Resolution: '1920x1080', FrameRate: 30 }),
    'https://video.twitch.tv/1080p30.m3u8',
    'exact resolution + framerate match'
);
assertEq(
    getStreamUrlForResolution(encodingsM3u8, { Resolution: '1280x720', FrameRate: 60 }),
    'https://video.twitch.tv/720p60.m3u8',
    'exact 720p60 match'
);
assertEq(
    getStreamUrlForResolution(encodingsM3u8, { Resolution: '1280x720', FrameRate: 30 }),
    'https://video.twitch.tv/720p60.m3u8',
    'resolution match without framerate match returns closest'
);
assert(
    getStreamUrlForResolution(encodingsM3u8, { Resolution: '1600x900', FrameRate: 30 }) != null,
    'non-exact resolution returns closest match'
);

// ============================================================
// Test: stripAdSegments
// ============================================================
console.log('--- stripAdSegments ---');

// Reset cache before each test group
AdSegmentCache = new Map();

// Test: strips ad segments
const adM3u8 = [
    '#EXTM3U',
    '#EXT-X-TWITCH-PREFETCH:https://prefetch.url',
    '#EXTINF:2.000,stitched-ad',
    'https://ad-segment-1.ts',
    '#EXTINF:2.000,live',
    'https://live-segment-1.ts',
].join('\n');

let streamInfo = { NumStrippedAdSegments: 0, IsStrippingAdSegments: false, RecoverySegments: [] };
let result = stripAdSegments(adM3u8, false, streamInfo);
assertEq(streamInfo.NumStrippedAdSegments, 1, 'counts stripped ad segment');
assert(streamInfo.IsStrippingAdSegments === true, 'marks as stripping');
assert(AdSegmentCache.has('https://ad-segment-1.ts'), 'caches ad segment URL');
assert(!result.includes('https://prefetch.url'), 'removes prefetch URLs during ads');
assert(streamInfo.RecoverySegments.length === 1, 'caches live segment for recovery');

// Test: no stripping on clean m3u8
AdSegmentCache = new Map();
const cleanM3u8 = [
    '#EXTM3U',
    '#EXTINF:2.000,live',
    'https://live-segment-1.ts',
    '#EXTINF:2.000,live',
    'https://live-segment-2.ts',
].join('\n');

streamInfo = { NumStrippedAdSegments: 5, IsStrippingAdSegments: false, RecoverySegments: [] };
result = stripAdSegments(cleanM3u8, false, streamInfo);
assertEq(streamInfo.NumStrippedAdSegments, 0, 'resets stripped count on clean m3u8');
assert(streamInfo.IsStrippingAdSegments === false, 'not stripping on clean m3u8');

// Test: SCTE-35 CUE-OUT/CUE-IN stripping
AdSegmentCache = new Map();
const scteM3u8 = [
    '#EXTM3U',
    '#EXT-X-CUE-OUT:DURATION=30',
    '#EXTINF:2.000,live',
    'https://cue-out-segment.ts',
    '#EXT-X-CUE-IN',
    '#EXTINF:2.000,live',
    'https://normal-segment.ts',
].join('\n');

streamInfo = { NumStrippedAdSegments: 0, IsStrippingAdSegments: false, RecoverySegments: [] };
result = stripAdSegments(scteM3u8, false, streamInfo);
assert(AdSegmentCache.has('https://cue-out-segment.ts'), 'strips segment inside CUE-OUT');
assert(!AdSegmentCache.has('https://normal-segment.ts'), 'does not strip segment after CUE-IN');

// Test: URL pattern detection
AdSegmentCache = new Map();
const urlPatternM3u8 = [
    '#EXTM3U',
    '#EXTINF:2.000,live',
    'https://cdn.twitch.tv/adsquared/ad-123.ts',
    '#EXTINF:2.000,live',
    'https://cdn.twitch.tv/normal-segment.ts',
].join('\n');

streamInfo = { NumStrippedAdSegments: 0, IsStrippingAdSegments: false, RecoverySegments: [] };
result = stripAdSegments(urlPatternM3u8, false, streamInfo);
assert(AdSegmentCache.has('https://cdn.twitch.tv/adsquared/ad-123.ts'), 'detects /adsquared/ URL pattern');
assert(!AdSegmentCache.has('https://cdn.twitch.tv/normal-segment.ts'), 'does not flag normal URL');

// Test: ad tracking URL replacement
AdSegmentCache = new Map();
const trackingM3u8 = [
    '#EXTM3U',
    '#EXTINF:2.000,stitched-ad',
    'https://ad.ts',
    'X-TV-TWITCH-AD-URL="https://tracking.example.com"',
    'X-TV-TWITCH-AD-CLICK-TRACKING-URL="https://click.example.com"',
    'X-TV-TWITCH-AD-FIRST-QUARTILE-URL="https://q1.example.com"',
    'X-TV-TWITCH-AD-IMPRESSION-URLS="https://imp.example.com"',
    'X-TV-TWITCH-AD-COMMERCIAL-ID="abc123"',
].join('\n');

streamInfo = { NumStrippedAdSegments: 0, IsStrippingAdSegments: false, RecoverySegments: [] };
result = stripAdSegments(trackingM3u8, false, streamInfo);
assert(result.includes('X-TV-TWITCH-AD-URL="https://twitch.tv"'), 'replaces ad URL with twitch.tv');
assert(result.includes('X-TV-TWITCH-AD-CLICK-TRACKING-URL="https://twitch.tv"'), 'replaces click tracking URL');
assert(result.includes('X-TV-TWITCH-AD-FIRST-QUARTILE-URL="https://twitch.tv"'), 'replaces quartile URL');
assert(result.includes('X-TV-TWITCH-AD-IMPRESSION-URLS="https://twitch.tv"'), 'replaces impression URLS (plural)');
assert(result.includes('X-TV-TWITCH-AD-COMMERCIAL-ID="abc123"'), 'leaves non-URL attributes alone');

// Test: recovery segments restore when all stripped
AdSegmentCache = new Map();
const allAdM3u8 = [
    '#EXTM3U',
    '#EXTINF:2.000,stitched-ad',
    'https://ad-1.ts',
    '#EXTINF:2.000,stitched-ad',
    'https://ad-2.ts',
].join('\n');

streamInfo = {
    NumStrippedAdSegments: 0,
    IsStrippingAdSegments: false,
    RecoverySegments: [
        { extinf: '#EXTINF:2.000,live', url: 'https://recovery-1.ts' },
        { extinf: '#EXTINF:2.000,live', url: 'https://recovery-2.ts' }
    ]
};
result = stripAdSegments(allAdM3u8, false, streamInfo);
assert(result.includes('https://recovery-1.ts'), 'restores recovery segment 1');
assert(result.includes('https://recovery-2.ts'), 'restores recovery segment 2');

// Test: MEDIA-SEQUENCE is rewritten on recovery injection
AdSegmentCache = new Map();
const playlistWithSeq = [
    '#EXTM3U',
    '#EXT-X-MEDIA-SEQUENCE:100',
    '#EXTINF:2.000,live',
    'https://s100.ts',
    '#EXTINF:2.000,live',
    'https://s101.ts',
    '#EXTINF:2.000,live',
    'https://s102.ts',
].join('\n');
// Cache phase: all 3 live segments, MEDIA-SEQUENCE=100 → RecoveryStartSeq = 100
streamInfo = { NumStrippedAdSegments: 0, IsStrippingAdSegments: false, RecoverySegments: [] };
stripAdSegments(playlistWithSeq, false, streamInfo);
assertEq(streamInfo.RecoveryStartSeq, 100, 'captures RecoveryStartSeq at cache time');
// Injection phase: ads-only playlist with MEDIA-SEQUENCE=200 → should rewrite to 100
AdSegmentCache = new Map();
const adOnlyWithSeq = [
    '#EXTM3U',
    '#EXT-X-MEDIA-SEQUENCE:200',
    '#EXTINF:2.000,stitched-ad',
    'https://ad.ts',
].join('\n');
result = stripAdSegments(adOnlyWithSeq, false, streamInfo);
assert(result.includes('#EXT-X-MEDIA-SEQUENCE:100'), 'rewrites MEDIA-SEQUENCE to match recovery segments');
assert(!result.includes('#EXT-X-MEDIA-SEQUENCE:200'), 'replaces original MEDIA-SEQUENCE');

// Test: stripAllSegments mode
AdSegmentCache = new Map();
const mixedM3u8 = [
    '#EXTM3U',
    '#EXTINF:2.000,live',
    'https://live-segment.ts',
].join('\n');

streamInfo = { NumStrippedAdSegments: 0, IsStrippingAdSegments: false, RecoverySegments: [] };
result = stripAdSegments(mixedM3u8, true, streamInfo);
assert(AdSegmentCache.has('https://live-segment.ts'), 'strips live segments when stripAllSegments is true');

// Test: /_404/ and /processing URL patterns
AdSegmentCache = new Map();
const urlPattern404M3u8 = [
    '#EXTM3U',
    '#EXTINF:2.000,live',
    'https://cdn.twitch.tv/_404/placeholder.ts',
    '#EXTINF:2.000,live',
    'https://cdn.twitch.tv/processing/ad-init.ts',
    '#EXTINF:2.000,live',
    'https://cdn.twitch.tv/normal-segment.ts',
].join('\n');

streamInfo = { NumStrippedAdSegments: 0, IsStrippingAdSegments: false, RecoverySegments: [] };
result = stripAdSegments(urlPattern404M3u8, false, streamInfo);
assert(AdSegmentCache.has('https://cdn.twitch.tv/_404/placeholder.ts'), 'detects /_404/ URL pattern');
assert(AdSegmentCache.has('https://cdn.twitch.tv/processing/ad-init.ts'), 'detects /processing URL pattern');
assert(!AdSegmentCache.has('https://cdn.twitch.tv/normal-segment.ts'), 'does not flag normal segment');

// Test: multiple signifiers in same m3u8
AdSegmentCache = new Map();
const multiSignifierM3u8 = [
    '#EXTM3U',
    '#EXT-X-CUE-OUT:DURATION=30',
    '#EXTINF:2.000,stitched-ad',
    'https://ad-1.ts',
    'X-TV-TWITCH-AD-URL="https://example.com"',
    '#EXT-X-CUE-IN',
    '#EXTINF:2.000,live',
    'https://live-1.ts',
].join('\n');

streamInfo = { NumStrippedAdSegments: 0, IsStrippingAdSegments: false, RecoverySegments: [] };
result = stripAdSegments(multiSignifierM3u8, false, streamInfo);
assert(streamInfo.IsStrippingAdSegments === true, 'detects ads with multiple signifiers');
assert(AdSegmentCache.has('https://ad-1.ts'), 'strips segment with multiple signifiers present');

// Test: AdSegmentCache deduplication
AdSegmentCache = new Map();
const dupeM3u8 = [
    '#EXTM3U',
    '#EXTINF:2.000,stitched-ad',
    'https://same-ad.ts',
].join('\n');

streamInfo = { NumStrippedAdSegments: 0, IsStrippingAdSegments: false, RecoverySegments: [] };
stripAdSegments(dupeM3u8, false, streamInfo);
assertEq(streamInfo.NumStrippedAdSegments, 1, 'first strip increments count');
streamInfo2 = { NumStrippedAdSegments: 0, IsStrippingAdSegments: false, RecoverySegments: [] };
stripAdSegments(dupeM3u8, false, streamInfo2);
assertEq(streamInfo2.NumStrippedAdSegments, 0, 'duplicate URL does not increment count (already cached)');

// ============================================================
// Test: isValidWorker
// ============================================================
console.log('--- isValidWorker ---');
assert(isValidWorker({ toString: () => 'function Worker() { /* twitch worker */ }' }) === false, 'rejects worker with twitch conflict');
assert(isValidWorker({ toString: () => 'function Worker() { isVariantA }' }) === true, 'allows worker with reinsert pattern (TwitchNoSub)');
assert(isValidWorker({ toString: () => 'function Worker() { besuper/ }' }) === true, 'allows worker with besuper reinsert');
assert(isValidWorker({ toString: () => 'function Worker() { /* clean */ }' }) === true, 'allows clean worker without conflicts');
assert(isValidWorker({ toString: () => 'function Worker() { twitch isVariantA }' }) === true, 'allows conflict + reinsert combination');
assert(isValidWorker({ toString: () => 'function Worker() { ${patch_url} }' }) === true, 'allows worker with ${patch_url} reinsert');

// ============================================================
// Test: AdSegmentCache TTL cleanup
// ============================================================
console.log('--- AdSegmentCache TTL ---');
AdSegmentCache = new Map();
AdSegmentCache.set('old-segment.ts', Date.now() - 130000);
AdSegmentCache.set('new-segment.ts', Date.now());
const now = Date.now();
AdSegmentCache.forEach((value, key, map) => {
    if (value < now - 120000) {
        map.delete(key);
    }
});
assert(!AdSegmentCache.has('old-segment.ts'), 'removes segments older than 120s');
assert(AdSegmentCache.has('new-segment.ts'), 'keeps recent segments');

// ============================================================
// Test: hasAdTags — each signifier individually
// ============================================================
console.log('--- hasAdTags (individual signifiers) ---');
assert(hasAdTags('stitched-ad') === true, 'detects stitched-ad alone');
assert(hasAdTags('EXT-X-CUE-OUT') === true, 'detects EXT-X-CUE-OUT alone');
assert(hasAdTags('twitch-stitched') === true, 'detects twitch-stitched prefix alone');
assert(hasAdTags('EXT-X-DATERANGE:CLASS="twitch-maf-ad"') === true, 'detects twitch-maf-ad DATERANGE alone');

// ============================================================
// Test: getStreamUrlForResolution — edge cases
// ============================================================
console.log('--- getStreamUrlForResolution (edge cases) ---');
assertEq(getStreamUrlForResolution('#EXTM3U\n', { Resolution: '1920x1080', FrameRate: 30 }), null, 'returns null for empty m3u8');
assertEq(getStreamUrlForResolution('', { Resolution: '1920x1080', FrameRate: 30 }), null, 'returns null for empty string');

// ============================================================
// Test: getServerTimeFromM3u8 — edge cases
// ============================================================
console.log('--- getServerTimeFromM3u8 (edge cases) ---');
V2API = false;
assertEq(getServerTimeFromM3u8('SERVER-TIME=""'), null, 'returns null for empty server time');
assertEq(getServerTimeFromM3u8('SERVER-TIME="abc"'), null, 'returns null for non-numeric v1 time');
V2API = true;
assertEq(getServerTimeFromM3u8('#EXT-X-SESSION-DATA:DATA-ID="OTHER",VALUE="123"'), null, 'returns null for wrong DATA-ID');
V2API = false;

// ============================================================
// Test: parseAttributes — edge cases
// ============================================================
console.log('--- parseAttributes (edge cases) ---');
const attrsEmpty = parseAttributes('');
assert(typeof attrsEmpty === 'object', 'returns object for empty string');

// ============================================================
// Results
// ============================================================
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function scriptFunction(source, name) {
    const declaration = new RegExp('    (?:async )?function ' + name + '\\(').exec(source);
    if (!declaration) throw new Error('Missing script function: ' + name);
    const end = source.indexOf('\n    }', declaration.index);
    return source.slice(declaration.index, end + 6);
}

function playbackContext(source) {
    const timers = new Map();
    const listeners = new Map();
    let nextTimer = 0;
    const video = {
        paused: false, ended: false, currentTime: 10, readyState: 2, plays: 0,
        buffered: { length: 2, start: i => i === 0 ? 0 : 40 },
        listeners: new Map(),
        addEventListener(name, listener) { this.listeners.set(name, listener); },
        play() { this.plays++; this.paused = false; return Promise.resolve(); }
    };
    const storage = new Map();
    const context = vm.createContext({
        console: { log() {}, error(message) { throw new Error(message); } },
        Response, Headers, AbortController, ReadableStream, DOMException,
        timers, listeners, video,
        setTimeout(callback, delay) { timers.set(++nextTimer, { callback, delay }); return nextTimer; },
        clearTimeout(id) { timers.delete(id); },
        document: {
            hidden: false, pictureInPictureElement: null,
            getElementById: () => null,
            addEventListener(name, listener) {
                if (!listeners.has(name)) listeners.set(name, []);
                listeners.get(name).push(listener);
            }
        },
        localStorage: {
            getItem: key => storage.get(key) ?? null,
            setItem: (key, value) => storage.set(key, value)
        },
        maskAsNative: fn => fn,
        backgroundResumeState: { chains: 0, loggedGiveUp: false },
        clearBackgroundResumeTimers() {},
        playPlayer: player => player.play(),
        hideTwitchAdOverlays() {}, updateAdblockBanner() {},
        isActivelyStrippingAds: false, playerForMonitoringBuffering: null
    });
    vm.runInContext(scriptFunction(source, 'declareOptions') + '; declareOptions(globalThis);', context);
    const bufferState = /const playerBufferState = (\{[\s\S]*?\n    \});/.exec(source);
    context.playerBufferState = bufferState ? vm.runInContext('(' + bufferState[1] + ')', context) : {};
    context.DisablePostBreakWedge = true;
    context.DisableInAdFreezeReload = true;
    context.playerAndState = {
        player: { core: {}, getHTMLVideoElement: () => video, isPaused: () => true, play: () => video.play() },
        state: { props: { content: { type: 'live' } } }
    };
    context.getPlayerAndState = () => context.playerAndState;
    return context;
}

async function testPlaybackRegressions() {
    console.log('--- Playback regressions (script source) ---');
    const scriptPaths = [
        'vaft/vaft.user.js', 'vaft/vaft-ublock-origin.js',
        'vaft/vaft_testing.user.js', 'vaft/vaft-testing-ublock-origin.js',
        'video-swap-new/video-swap-new.user.js',
        'video-swap-new/video-swap-new-ublock-origin.js',
        'video-swap-new/video-swap-new-ublock-origin-testing.js'
    ];
    for (const scriptPath of scriptPaths) {
        const source = fs.readFileSync(path.join(__dirname, '..', scriptPath), 'utf8');
        const context = playbackContext(source);
        const label = scriptPath + ': ';
        vm.runInContext(scriptFunction(source, 'onContentLoaded') + '; onContentLoaded();', context);
        const visibilityChange = context.listeners.get('visibilitychange')[0];
        const hide = () => { context.document.hidden = true; visibilityChange(); };
        const focus = () => { context.document.hidden = false; visibilityChange(); };
        context.video.paused = true;
        focus();
        assertEq(context.video.plays, 0, label + 'initial visibility event preserves pause');
        context.playerAndState.state.props.content.type = 'video';
        context.video.paused = false;
        hide();
        context.video.paused = true;
        focus();
        assertEq(context.video.plays, 0, label + 'focus never resumes a VOD');
        context.playerAndState.state.props.content.type = 'live';
        hide();
        focus();
        assertEq(context.video.plays, 0, label + 'live stream paused before hiding stays paused');
        context.video.paused = false;
        hide();
        context.video.paused = true;
        focus();
        assertEq(context.video.plays, 1, label + 'live playback resumes after background pause');
        if (scriptPath.startsWith('vaft/')) {
            context.video.paused = false;
            hide();
            context.video.paused = true;
            context.playerBufferState.userPauseIntent = true;
            focus();
            assertEq(context.video.plays, 1, label + 'focus respects user pause intent');
            context.playerBufferState.userPauseIntent = false;
        }
        context.video.paused = false;
        hide();
        context.playerAndState.state.props.content.type = 'video';
        context.video.paused = true;
        focus();
        assertEq(context.video.plays, 1, label + 'switching to VOD cancels live resume intent');
        context.playerAndState.state.props.content.type = 'live';
        focus();
        assertEq(context.video.plays, 1, label + 'stale focus does not resume a different stream');

        if (!scriptPath.startsWith('vaft/')) continue;
        const templateStart = source.indexOf('const newBlobStr = `') + 'const newBlobStr = '.length;
        const workerTemplate = source.slice(templateStart, source.indexOf('`;', templateStart) + 1);
        for (const match of workerTemplate.matchAll(/\$\{(\w+)\.toString\(\)\}/g)) {
            vm.runInContext(scriptFunction(source, match[1]), context);
        }
        context.twitchBlobUrl = 'blob:https://www.twitch.tv/worker';
        const workerSource = vm.runInContext(workerTemplate, context);
        assert(new vm.Script(workerSource) instanceof vm.Script, label + 'serialized worker parses after interpolation');
        const relayStart = source.indexOf('                            const responseData = e.data.value;');
        const relayEnd = source.indexOf("\n                        } else if (e.data.key == 'TriggeredPlayerReload')", relayStart);
        context.relay = vm.runInContext('(function(e) {' + source.slice(relayStart, relayEnd) + '\n})', context);
        for (const status of [200, 204, 205, 304, 0, 101, 600]) {
            let settled;
            context.pendingFetchRequests = new Map([[1, {
                resolve: response => { settled = { response }; },
                reject: error => { settled = { error }; }
            }]]);
            context.relay({ data: { value: {
                id: 1, status, body: status === 200 ? 'content' : '',
                headers: { 'x-relay': 'preserved' }, url: 'https://example.com/token', type: 'cors', redirected: true
            } } });
            assertEq(context.pendingFetchRequests.size, 0, label + 'relay removes completed request ' + status);
            if ([0, 101, 600].includes(status)) {
                assertEq(settled?.error?.name, 'RangeError', label + 'invalid status rejects instead of hanging: ' + status);
            } else {
                assertEq(settled?.response?.status, status, label + 'relay reconstructs status ' + status);
                assertEq(await settled.response.text(), status === 200 ? 'content' : '', label + 'relay preserves body semantics ' + status);
                assertEq(settled.response.url, 'https://example.com/token', label + 'relay preserves response URL ' + status);
                assertEq(settled.response.type, 'cors', label + 'relay preserves response type ' + status);
                assertEq(settled.response.redirected, true, label + 'relay preserves redirect metadata ' + status);
                assertEq(settled.response.headers.get('x-relay'), 'preserved', label + 'relay preserves headers ' + status);
            }
        }
        context.handleWorkerFetchRequest = vm.runInContext('(' + scriptFunction(source, 'handleWorkerFetchRequest') + ')', context);
        let bodyController;
        context.window = { realFetch: async (url, options) => new Response(new ReadableStream({
            start(controller) {
                bodyController = controller;
                options.signal.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
            }
        })) };
        context.timers.clear();
        const pendingBody = context.handleWorkerFetchRequest({ id: 2, url: 'https://example.com/token' });
        await Promise.resolve();
        await Promise.resolve();
        assertEq(context.timers.size, 1, label + 'abort timeout remains active while reading the body');
        if (context.timers.size) context.timers.values().next().value.callback();
        else bodyController.error(new DOMException('aborted', 'AbortError'));
        assertEq((await pendingBody).error, 'GQL fetch timeout (5s)', label + 'stalled body read returns timeout error');
        assertEq(context.timers.size, 0, label + 'failed body read clears timeout');

        vm.runInContext(scriptFunction(source, 'parseAttributes') + '\n' + scriptFunction(source, 'notifyAdComplete'), context);
        const batches = [];
        context.gqlRequest = batch => { batches.push(batch); return Promise.resolve({ status: 200 }); };
        const ad = (id, length) => '#EXT-X-DATERANGE:ID="stitched-ad-' + id + '",X-TV-TWITCH-AD-RADS-TOKEN="token"' + (length ? ',X-TV-TWITCH-AD-POD-LENGTH="' + length + '"' : '') + '\n';
        const knownPod = { SpoofedAdIds: new Set() };
        context.notifyAdComplete(ad('a', 2) + ad('b', 2) + ad('c', 2), knownPod);
        assertEq(batches.length, 2, label + 'spoofing stops at the declared pod length');
        assertEq(batches.flat().filter(packet => packet.variables.input.eventName === 'video_ad_pod_complete').length, 1, label + 'declared pod completes once');
        batches.length = 0;
        const unknownPod = { SpoofedAdIds: new Set() };
        context.notifyAdComplete(ad('d'), unknownPod);
        context.notifyAdComplete(ad('e'), unknownPod);
        assertEq(batches.length, 2, label + 'unknown pod length does not skip later ads');
        assertEq(batches.flat().filter(packet => packet.variables.input.eventName === 'video_ad_pod_complete').length, 0, label + 'unknown pod never reports completion');
        batches.length = 0;
        context.notifyAdComplete(ad('f'));
        assertEq(batches.flat().filter(packet => packet.variables.input.eventName === 'video_ad_pod_complete').length, 0, label + 'missing dedup state cannot complete an unknown pod');

        const monitorContext = playbackContext(source);
        vm.runInContext(scriptFunction(source, 'monitorPlayerBuffering'), monitorContext);
        const lookupError = new Error('player lookup failed');
        monitorContext.getPlayerAndState = () => { throw lookupError; };
        let tickError;
        try { monitorContext.monitorPlayerBuffering(); } catch (error) { tickError = error; }
        assertEq(tickError, lookupError, label + 'monitor exposes player lookup errors');
        assertEq(monitorContext.timers.size, 1, label + 'monitor reschedules after player lookup errors');
        monitorContext.getPlayerAndState = () => null;
        monitorContext.monitorPlayerBuffering();
        assertEq(monitorContext.timers.size, 1, label + 'manual monitor tick replaces the scheduled tick');
        for (const listener of monitorContext.listeners.get('visibilitychange')) listener();
        assertEq(monitorContext.timers.size, 1, label + 'focus wakeup leaves one monitor timer');
        monitorContext.document.hidden = true;
        monitorContext.monitorPlayerBuffering();
        assertEq(monitorContext.timers.values().next().value.delay, monitorContext.PlayerBufferingDelay * 3, label + 'idle hidden tabs retain polling backoff');
        monitorContext.playerBufferState.inAdBreak = true;
        monitorContext.monitorPlayerBuffering();
        assertEq(monitorContext.timers.values().next().value.delay, monitorContext.PlayerBufferingDelay, label + 'hidden ad breaks retain normal polling');

        const pauseContext = playbackContext(source);
        pauseContext.DisableBackgroundResume = true;
        vm.runInContext(scriptFunction(source, 'onContentLoaded') + '; onContentLoaded();', pauseContext);
        vm.runInContext(scriptFunction(source, 'monitorPlayerBuffering') + '; monitorPlayerBuffering();', pauseContext);
        const pauseVisibilityChange = pauseContext.listeners.get('visibilitychange')[0];
        pauseContext.document.hidden = true;
        pauseVisibilityChange();
        pauseContext.video.paused = true;
        pauseContext.video.listeners.get('pause')();
        pauseContext.document.hidden = false;
        pauseVisibilityChange();
        assertEq(pauseContext.video.plays, 1, label + 'hidden-tab pause event still allows live recovery on focus');
        pauseContext.video.paused = true;
        pauseContext.video.listeners.get('pause')();
        pauseContext.document.hidden = true;
        pauseVisibilityChange();
        pauseContext.document.hidden = false;
        pauseVisibilityChange();
        assertEq(pauseContext.video.plays, 1, label + 'visible user pause event stays paused across focus changes');

        if (scriptPath.includes('testing')) {
            const pipContext = playbackContext(source);
            pipContext.document.pictureInPictureElement = pipContext.video;
            pipContext.iosSoftReload = false;
            pipContext.playerAndState.player.isPaused = () => pipContext.video.paused;
            pipContext.playerAndState.player.pause = () => { pipContext.video.paused = true; };
            pipContext.playerAndState.state.setSrc = () => { throw new Error('PiP player must not be replaced'); };
            vm.runInContext(scriptFunction(source, 'doTwitchPlayerTask'), pipContext);
            pipContext.doTwitchPlayerTask(false, true, 'early');
            assertEq(pipContext.video.plays, 1, label + 'PiP reload uses pause/play without replacing the player');
            pipContext.video.paused = true;
            pipContext.doTwitchPlayerTask(false, true, 'early');
            assertEq(pipContext.video.plays, 1, label + 'PiP reload preserves a paused player');
            continue;
        }
        const gapContext = playbackContext(source);
        vm.runInContext(scriptFunction(source, 'monitorPlayerBuffering'), gapContext);
        gapContext.playerBufferState.inAdBreak = true;
        for (let tick = 0; tick < 3; tick++) gapContext.monitorPlayerBuffering();
        assertEq(gapContext.video.currentTime, 10, label + 'buffer-gap seek waits for three frozen intervals');
        gapContext.monitorPlayerBuffering();
        assertEq(gapContext.video.currentTime, 40.05, label + 'frozen live stream seeks into the next buffered range');
        gapContext.video.currentTime = 10;
        gapContext.playerBufferState.userPauseIntent = true;
        for (let tick = 0; tick < 4; tick++) gapContext.monitorPlayerBuffering();
        assertEq(gapContext.video.currentTime, 10, label + 'buffer-gap recovery respects deliberate pause');
        gapContext.playerBufferState.userPauseIntent = false;
        gapContext.playerAndState.state.props.content.type = 'video';
        for (let tick = 0; tick < 4; tick++) gapContext.monitorPlayerBuffering();
        assertEq(gapContext.video.currentTime, 10, label + 'buffer-gap recovery never seeks VODs');
        gapContext.playerAndState.state.props.content.type = 'live';
        gapContext.video.paused = true;
        for (let tick = 0; tick < 4; tick++) gapContext.monitorPlayerBuffering();
        gapContext.video.paused = false;
        gapContext.monitorPlayerBuffering();
        assertEq(gapContext.playerBufferState.gapJumpStuckTicks, 0, label + 'paused ticks do not count as frozen playback');
        for (let tick = 0; tick < 4; tick++) {
            gapContext.video.currentTime++;
            gapContext.monitorPlayerBuffering();
        }
        assertEq(gapContext.video.currentTime, 14, label + 'advancing playback is never gap-seeked');
        gapContext.video.buffered.length = 1;
        for (let tick = 0; tick < 4; tick++) gapContext.monitorPlayerBuffering();
        assertEq(gapContext.video.currentTime, 14, label + 'a single buffered range cannot trigger a gap seek');
        gapContext.video.buffered.length = 2;
        gapContext.video.readyState = 3;
        for (let tick = 0; tick < 4; tick++) gapContext.monitorPlayerBuffering();
        assertEq(gapContext.video.currentTime, 14, label + 'a player with enough data is not gap-seeked');
        gapContext.playerBufferState.inAdBreak = false;
        gapContext.monitorPlayerBuffering();
        assertEq(gapContext.playerBufferState.gapJumpStuckTicks, 0, label + 'ending a break clears frozen-gap evidence');

    }
}

testPlaybackRegressions().then(() => {
    console.log('\n' + passed + ' passed, ' + failed + ' failed');
    process.exitCode = failed > 0 ? 1 : 0;
}).catch(error => {
    console.error(error);
    process.exitCode = 1;
});
