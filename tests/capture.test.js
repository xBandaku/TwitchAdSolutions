const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeCapture } = require('./capture');

test('synthetic resilience: capture redaction preserves URL relationships and removes private values', () => {
    const channel = 'private_channel';
    const url = 'https://edge.example/private_channel/secret-session/index.m3u8?token=secret-token&sig=secret-signature';
    const master = '#EXTM3U\r\n#EXT-X-SESSION-DATA:DATA-ID="USER-IP",VALUE="192.0.2.99"\r\n'
        + '#EXT-X-SESSION-DATA:DATA-ID="VIDEO-SESSION-ID",VALUE="private-session"\r\n'
        + '#EXT-X-SESSION-DATA:DATA-ID="SERVER-TIME",VALUE="1234"\r\n'
        + '#EXT-X-SESSION-DATA:DATA-ID="SERVER-TIME",VALUE="private-not-a-time"\r\n'
        + '#EXT-X-SESSION-DATA:DATA-ID="CUSTOM",URI="https://edge.example/secret-data.json?token=secret-token"\r\n'
        + '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,CODECS="avc1.4d4028"\r\n' + url + '\r\n';
    const media = '#EXTM3U\n#EXT-X-DATERANGE:ID="private-id",CLASS="twitch-stream-source",X-TV-TWITCH-SESSIONID="private-session"\n'
        + '#EXT-X-KEY:METHOD=AES-128,URI="../secret-key.bin?token=secret-token"\n'
        + '#EXTINF:2,live\n../secret-segment.ts\n#EXT-X-TWITCH-PREFETCH:../next-secret.ts\n';
    const capture = {
        master: { request: { url: 'https://usher.ttvnw.net/api/v2/channel/hls/private_channel.m3u8?token=secret-token&allow_source=true' },
            response: { finalUrl: url, redirectHistory: [{ status: 302, url, location: '../secret-redirect.m3u8?sig=secret-signature' }], body: master } },
        media: { request: { url }, response: { finalUrl: url, redirectHistory: [], body: media } }
    };
    const sanitized = sanitizeCapture(capture, channel);
    const text = JSON.stringify(sanitized);
    for (const secret of ['private_channel', 'secret-session', 'secret-token', 'secret-signature', '192.0.2.99',
        'private-session', 'private-not-a-time', 'private-id', 'secret-data', 'secret-key', 'secret-segment', 'next-secret', 'secret-redirect', 'edge.example']) {
        assert.ok(!text.includes(secret), secret);
    }
    assert.ok(sanitized.master.response.body.includes(sanitized.media.request.url));
    assert.ok(sanitized.master.request.url.includes('allow_source=true'));
    assert.ok(sanitized.master.response.body.includes('VALUE="1234"\r\n'));
    assert.match(sanitized.media.response.body, /URI="\.\.\/redacted-\d+\.bin\?token=redacted-\d+"/);
    assert.match(sanitized.media.response.body, /#EXT-X-TWITCH-PREFETCH:\.\.\/redacted-\d+\.ts/);
    assert.equal(sanitized.master.response.redirectHistory[0].status, 302);
    assert.equal(capture.master.response.body, master);
});

test('synthetic resilience: redaction preserves an ad URL detection condition', () => {
    const body = '#EXTM3U\n#EXTINF:2,live\nhttps://edge.example/adsquared/secret.ts\n';
    const response = { finalUrl: 'https://edge.example/index.m3u8', redirectHistory: [], body };
    const exchange = { request: { url: response.finalUrl }, response };
    const sanitized = sanitizeCapture({ master: exchange, media: structuredClone(exchange) }, 'channel');
    assert.deepEqual(sanitized.media.coverage.adUrlMatches, [1, 0, 0]);
});
