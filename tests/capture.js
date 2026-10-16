const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { readScript, createScriptContext } = require('./scripts');

function playlistCoverage(body) {
    const context = createScriptContext(readScript('vaft/vaft.user.js'));
    const lines = body.split(/\r?\n/);
    const variants = lines.filter(line => line.startsWith('#EXT-X-STREAM-INF:')).map(line => context.parseAttributes(line));
    const enhanced = variant => ['hevc', 'av1'].includes(context.videoCodecFamily(variant.CODECS));
    const uris = lines.filter(line => line && !line.startsWith('#'));
    return {
        variants: variants.length,
        withResolution: variants.filter(v => v.RESOLUTION).length,
        avcWithResolution: variants.filter(v => v.RESOLUTION && context.videoCodecFamily(v.CODECS) === 'avc').length,
        enhancedWithResolution: variants.filter(v => v.RESOLUTION && enhanced(v)).length,
        enhancedWithoutResolution: variants.filter(v => !v.RESOLUTION && enhanced(v)).length,
        relativeUris: uris.filter(uri => !/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(uri)).length,
        segments: lines.filter(line => line.startsWith('#EXTINF:')).length,
        adSignifiers: Array.from(context.getMatchedAdSignifiers(body)),
        adUrlMatches: Array.from(context.AdSegmentURLPatterns, pattern => body.split(pattern).length - 1)
    };
}

function sanitizeCapture(capture, channel) {
    const replacements = new Map();
    const replace = value => {
        if (!replacements.has(value)) replacements.set(value, 'redacted-' + (replacements.size + 1));
        return replacements.get(value);
    };
    const hosts = new Map();
    const publicParams = new Set(['allow_source', 'allow_audio_only', 'allow_spectre', 'platform', 'player', 'supported_codecs', 'playlist_include_framerate']);
    const safeParts = /^(?:|\.|\.\.|api|v2|channel|hls|chunked|audio_only|index\.m3u8|adsquared|_404|processing|\d+p\d*)$/;
    const sanitizeUri = uri => {
        const match = /^(?:([a-z][a-z\d+.-]*:)?\/\/([^/?#]+))?([^?#]*)(\?[^#]*)?(#.*)?$/i.exec(uri);
        if (!match) throw new Error('Cannot sanitize playlist URI');
        let [, protocol, host, pathname, query, fragment] = match;
        if (host && host !== 'usher.ttvnw.net') {
            if (!hosts.has(host)) hosts.set(host, 'cdn-' + (hosts.size + 1) + '.invalid');
            host = hosts.get(host);
        }
        pathname = pathname.split('/').map(part => {
            if (part === channel + '.m3u8') return 'fixture-channel.m3u8';
            if (safeParts.test(part)) return part;
            const extension = /\.(m3u8|ts|mp4|m4s|aac|key|bin)$/.exec(part)?.[0] || '';
            return replace(part) + extension;
        }).join('/');
        if (query) {
            const params = new URLSearchParams(query);
            query = '?' + Array.from(params, ([key, value]) => encodeURIComponent(key) + '='
                + encodeURIComponent(publicParams.has(key) ? value : replace(value))).join('&');
        }
        return (host ? (protocol || '') + '//' + host : '') + pathname + (query || '') + (fragment ? '#' + replace(fragment) : '');
    };
    const safeAttributes = new Set(['CLASS', 'START-DATE', 'END-DATE', 'END-ON-NEXT', 'DURATION', 'PLANNED-DURATION', 'X-SERVER-TIME',
        'X-TV-TWITCH-AD-POD-LENGTH', 'X-TV-TWITCH-AD-POD-POSITION', 'X-TV-TWITCH-AD-DURATION', 'X-TV-TWITCH-AD-ROLL-TYPE']);
    const sanitizeBody = body => body.split(/(\r?\n)/).map(line => {
        if (/^\r?\n$/.test(line) || !line) return line;
        if (!line.startsWith('#')) return sanitizeUri(line);
        if (line.startsWith('#EXT-X-SESSION-DATA:')) {
            const timing = /DATA-ID="(?:SERVER-TIME|STREAM-TIME)"/.test(line);
            return line.replace(/([,:])([\w-]+)=("[^"]*"|[^,]*)/g, (attribute, prefix, key, value) => {
                if (key === 'DATA-ID' || key === 'LANGUAGE') return attribute;
                if (key === 'VALUE' && timing && /^"\d+(?:\.\d+)?"$/.test(value)) return attribute;
                if (key === 'URI') return prefix + key + '="' + sanitizeUri(value.slice(1, -1)) + '"';
                return prefix + key + '="' + replace(value) + '"';
            });
        }
        if (line.startsWith('#EXT-X-TWITCH-PREFETCH:')) {
            return '#EXT-X-TWITCH-PREFETCH:' + sanitizeUri(line.slice('#EXT-X-TWITCH-PREFETCH:'.length));
        }
        line = line.replace(/([,:])URI="([^"]+)"/g, (_, prefix, uri) => prefix + 'URI="' + sanitizeUri(uri) + '"');
        if (line.startsWith('#EXT-X-DATERANGE:') || line.startsWith('#EXT-X-TWITCH-INFO:')) {
            line = line.replace(/([,:])([\w-]+)=("[^"]*"|[^,]*)/g, (attribute, prefix, key, value) => {
                if (safeAttributes.has(key)) return attribute;
                return prefix + key + '="' + replace(value) + '"';
            });
        }
        return line;
    }).join('');
    const sanitized = structuredClone(capture);
    for (const exchange of [sanitized.master, sanitized.media]) {
        exchange.request.url = sanitizeUri(exchange.request.url);
        exchange.response.finalUrl = sanitizeUri(exchange.response.finalUrl);
        exchange.response.redirectHistory = exchange.response.redirectHistory.map(hop => ({
            status: hop.status, url: sanitizeUri(hop.url), location: sanitizeUri(hop.location)
        }));
        const body = exchange.response.body;
        exchange.response.sourceSha256 = createHash('sha256').update(body).digest('hex');
        exchange.response.body = sanitizeBody(body);
        assert.deepEqual(playlistCoverage(exchange.response.body), playlistCoverage(body), 'Sanitization changed playlist coverage');
        exchange.response.sanitizedSha256 = createHash('sha256').update(exchange.response.body).digest('hex');
        exchange.coverage = playlistCoverage(exchange.response.body);
    }
    sanitized.sanitization = [
        'Channel names, CDN hosts, opaque path components, fragments and non-public query values replaced consistently.',
        'Session-data values and tracking attributes redacted; tag order, line endings, codecs, resolutions and timing retained.',
        'Only the response Content-Type header retained. No cookies, authorization headers or token responses stored.',
        'Variant counts, missing-resolution counts, relative URI counts and ad-signifier matches checked before and after redaction.'
    ];
    return sanitized;
}

async function capturePlaylist(channel, output, playerType = 'popout', api = 'v2') {
    if (!/^[a-z\d_]+$/.test(channel) || !['v1', 'v2'].includes(api)) throw new Error('Invalid channel or API version');
    if (fs.existsSync(output)) throw new Error('Capture output already exists');
    const context = createScriptContext(readScript('vaft/vaft.user.js'));
    context.gqlRequest = body => body;
    const tokenResponse = await fetch('https://gql.twitch.tv/gql', {
        method: 'POST', headers: { 'Client-ID': context.ClientID, 'Content-Type': 'application/json' },
        body: JSON.stringify(context.getAccessToken(channel, playerType)), signal: AbortSignal.timeout(15000)
    });
    if (!tokenResponse.ok) throw new Error('Playback token HTTP ' + tokenResponse.status);
    const token = (await tokenResponse.json()).data?.streamPlaybackAccessToken;
    if (!token) throw new Error('Playback token missing');
    const url = new URL('https://usher.ttvnw.net/api/' + (api === 'v2' ? 'v2/' : '') + 'channel/hls/' + channel + '.m3u8');
    for (const [key, value] of Object.entries({ sig: token.signature, token: token.value, allow_source: 'true', allow_audio_only: 'true',
        allow_spectre: 'true', player: 'twitchweb', platform: 'web', supported_codecs: 'av1,h265,h264', playlist_include_framerate: 'true' })) {
        url.searchParams.set(key, value);
    }
    const fetchPlaylist = async requestUrl => {
        let next = requestUrl;
        const redirectHistory = [];
        const signal = AbortSignal.timeout(15000);
        for (let attempt = 0; attempt < 10; attempt++) {
            const response = await fetch(next, { redirect: 'manual', signal });
            if ([301, 302, 303, 307, 308].includes(response.status)) {
                const location = response.headers.get('location');
                if (!location) throw new Error('Redirect without Location');
                const target = new URL(location, next);
                if (target.protocol !== 'https:') throw new Error('Playlist redirected outside HTTPS');
                redirectHistory.push({ status: response.status, url: next, location });
                await response.body?.cancel();
                next = target.href;
                continue;
            }
            if (!response.ok) throw new Error('Playlist HTTP ' + response.status);
            const body = await response.text();
            if (!body.startsWith('#EXTM3U')) throw new Error('Response is not HLS');
            return { request: { method: 'GET', url: requestUrl }, response: {
                status: response.status, finalUrl: response.url, redirectHistory,
                headers: { 'content-type': response.headers.get('content-type') }, body
            } };
        }
        throw new Error('Playlist redirect limit reached');
    };
    const master = await fetchPlaylist(url.href);
    const lines = master.response.body.split(/\r?\n/);
    const variant = lines.findIndex(line => line.startsWith('#EXT-X-STREAM-INF:') && context.parseAttributes(line).RESOLUTION);
    if (variant === -1) throw new Error('No video variant available');
    const media = await fetchPlaylist(new URL(lines[variant + 1], master.response.finalUrl).href);
    const capture = sanitizeCapture({ schemaVersion: 1, evidence: 'captured response', capturedAt: new Date().toISOString(),
        access: 'anonymous', api, playerType, master, media }, channel);
    fs.writeFileSync(output, JSON.stringify(capture, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ output, master: capture.master.coverage, media: capture.media.coverage }));
}

if (require.main === module) {
    const [channel, output, playerType, api] = process.argv.slice(2);
    if (!channel || !output) throw new Error('Usage: node tests/capture.js <channel> <output.json> [playerType] [v1|v2]');
    capturePlaylist(channel, output, playerType, api).catch(error => {
        console.error('Capture failed: ' + error.message);
        process.exitCode = 1;
    });
}

module.exports = { playlistCoverage, sanitizeCapture };
