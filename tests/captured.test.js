const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { readScript, createScriptContext } = require('./scripts');
const { playlistCoverage } = require('./capture');

const directory = path.join(__dirname, 'fixtures/captured');
const fixtures = fs.readdirSync(directory).filter(file => file.endsWith('.json'));
assert.ok(fixtures.length > 0, 'At least one captured Twitch response is required');

for (const name of fixtures) {
    const capture = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
    test('captured response: ' + name + ' has provenance and unchanged sanitized bodies', () => {
        assert.equal(capture.schemaVersion, 1);
        assert.equal(capture.evidence, 'captured response');
        assert.ok(Number.isFinite(Date.parse(capture.capturedAt)));
        assert.equal(capture.access, 'anonymous');
        assert.ok(['v1', 'v2'].includes(capture.api));
        assert.ok(capture.playerType);
        assert.ok(capture.sanitization.length > 0);
        for (const exchange of [capture.master, capture.media]) {
            assert.equal(exchange.request.method, 'GET');
            assert.equal(exchange.response.status, 200);
            assert.equal(new URL(exchange.request.url).protocol, 'https:');
            assert.equal(new URL(exchange.response.finalUrl).protocol, 'https:');
            assert.ok(Array.isArray(exchange.response.redirectHistory));
            for (const hop of exchange.response.redirectHistory) {
                assert.ok([301, 302, 303, 307, 308].includes(hop.status));
                assert.ok(hop.url && hop.location);
            }
            assert.deepEqual(Object.keys(exchange.response.headers), ['content-type']);
            assert.match(exchange.response.sourceSha256, /^[a-f\d]{64}$/);
            assert.equal(createHash('sha256').update(exchange.response.body).digest('hex'), exchange.response.sanitizedSha256);
            assert.deepEqual(playlistCoverage(exchange.response.body), exchange.coverage);
        }
    });

    for (const file of ['video-swap-new/video-swap-new.user.js', 'video-swap-new/video-swap-new-ublock-origin.js', 'strip/strip.user.js']) {
        test('captured response: ' + name + ' replays master and media hooks through ' + file, async t => {
            const requested = [];
            const context = createScriptContext(readScript(file), {
                console: { log() {}, error() {} }, URL, Request, Response, Headers, Blob, AbortController, Uint8Array, atob,
                setTimeout, clearTimeout, postMessage() {}, fetch: async input => {
                    const url = typeof input === 'string' ? input : input.url;
                    requested.push(url);
                    const exchange = [capture.master, capture.media].find(item => item.request.url === url);
                    assert.ok(exchange, 'Unrecorded network request: ' + url);
                    const response = new Response(exchange.response.body, {
                        status: exchange.response.status, headers: exchange.response.headers
                    });
                    Object.defineProperty(response, 'url', { value: exchange.response.finalUrl });
                    return response;
                }
            });
            let processed = 0;
            const method = file.startsWith('strip/') ? 'stripAdSegments' : 'processM3U8';
            const original = context[method];
            context[method] = (...args) => { processed++; return original(...args); };
            context.hookWorkerFetch();
            assert.match(await (await context.fetch(capture.master.request.url)).text(), /^#EXTM3U/);
            const media = await (await context.fetch(capture.media.request.url)).text();
            assert.match(media, /^#EXTM3U/);
            const resolved = context.resolvePlaylistUrls(capture.media.response.body, capture.media.response.finalUrl);
            for (const url of resolved.split(/\r?\n/).filter(line => line && !line.startsWith('#'))) {
                assert.ok(media.includes(url), 'Captured clean media URI was lost');
            }
            assert.ok(requested.includes(capture.master.request.url));
            assert.ok(requested.includes(capture.media.request.url));
            assert.ok(processed > 0, 'Captured media bypassed the processing hook');
            t.diagnostic('Unmodified sanitized capture replay; no live ad-break reproduction. Enhanced-codec and redirected relative-master triggers: NOT EXERCISED.');
        });
    }

    for (const file of ['vaft/vaft.user.js', 'vaft/vaft-ublock-origin.js']) {
        test('captured response: ' + name + ' loads through ' + file, async t => {
            const context = createScriptContext(readScript(file), {
                console: { log() {} }, URL, Request, Response, Headers, Blob, AbortController, Uint8Array, atob,
                setTimeout, clearTimeout, postMessage() {}, fetch: async url => {
                    assert.equal(String(url), capture.master.request.url, 'Unrecorded network request');
                    const response = new Response(capture.master.response.body, {
                        status: capture.master.response.status, headers: capture.master.response.headers
                    });
                    Object.defineProperty(response, 'url', { value: capture.master.response.finalUrl });
                    return response;
                }
            });
            context.hookWorkerFetch();
            const response = await context.fetch(capture.master.request.url);
            assert.equal(response.status, 200);
            const stream = context.ActiveStreamInfo;
            const coverage = capture.master.coverage;
            assert.equal(stream.ResolutionList.length, coverage.withResolution);
            assert.ok(Object.keys(stream.Urls).includes(capture.media.request.url));
            const rewriteRan = stream.ModifiedM3U8 !== null;
            assert.equal(rewriteRan, coverage.avcWithResolution > 0 && coverage.enhancedWithResolution > 0);
            t.diagnostic('Enhanced-codec rewrite: ' + (rewriteRan ? 'exercised' : 'NOT EXERCISED')
                + '; missing-resolution guard: ' + (rewriteRan && coverage.enhancedWithoutResolution > 0 ? 'exercised' : 'NOT EXERCISED')
                + '; redirected master with relative URIs: ' + (capture.master.response.redirectHistory.length > 0 && coverage.relativeUris > 0 ? 'exercised' : 'NOT EXERCISED'));
            const media = context.resolvePlaylistUrls(capture.media.response.body, capture.media.response.finalUrl);
            const stripped = context.stripAdSegments(media, false, stream);
            assert.ok(stripped.startsWith('#EXTM3U'));
            const lines = media.split(/\r?\n/);
            for (let i = 0; i < lines.length - 1; i++) {
                if (lines[i].startsWith('#EXTINF:') && lines[i].endsWith(',live')
                    && !context.AdSegmentURLPatterns.some(pattern => lines[i + 1].includes(pattern))) {
                    assert.ok(stripped.includes(lines[i + 1]), 'Captured live segment was removed');
                }
            }
            t.diagnostic('Recorded media replayed through URL resolution and stripping; no browser playback or live ad-break reproduction claimed.');
        });
    }
}
