const test = require('node:test');
const assert = require('node:assert/strict');
const { readScript, createScriptContext } = require('./scripts');

for (const file of ['vaft/vaft.user.js', 'vaft/vaft-ublock-origin.js',
    'video-swap-new/video-swap-new.user.js', 'video-swap-new/video-swap-new-ublock-origin.js']) {
    test('synthetic resilience: diagnostic export is bounded and excludes private fields in ' + file, () => {
        const window = { __tasDiagnostics: { script: 'vaft', version: 'fixture', startedAt: Date.now(),
            current: {}, events: [], render() {} } };
        const context = createScriptContext(readScript(file), { window });
        for (let i = 0; i < 150; i++) context.recordTASDiagnostic({ event: 'backup-attempt', playerType: 'popout',
            quality: '640x360', durationMs: 25, url: 'https://private.invalid/token',
            authorization: 'OAuth secret', channelName: 'private-channel' });
        context.recordTASDiagnostic({ event: 'backup-selected', playerType: 'secret-token', quality: 'private-url' });
        const report = context.getTASDiagnostics();
        assert.equal(report.events.length, 100);
        assert.equal(report.current.backup, 'unknown');
        assert.equal(report.current.quality, 'unknown');
        const json = JSON.stringify(report);
        for (const privateValue of ['private.invalid', 'OAuth secret', 'private-channel', 'secret-token', 'private-url']) {
            assert.ok(!json.includes(privateValue), 'export leaked ' + privateValue);
        }
        report.events.length = 0;
        assert.equal(window.__tasDiagnostics.events.length, 100, 'export must be a snapshot');
    });

    if (file.startsWith('vaft/')) {
        for (const event of ['reload-request', 'reload-start']) {
            test('synthetic resilience: new ' + event + ' clears the previous outcome in ' + file, () => {
                const window = { __tasDiagnostics: { startedAt: Date.now(), current: {}, events: [], render() {} } };
                const context = createScriptContext(readScript(file), { window });
                context.recordTASDiagnostic({ event: 'recovery-finished', success: true, reason: 'progress', attempt: 1 });
                assert.equal(window.__tasDiagnostics.current.recoveryOutcome, 'progress-observed');
                context.recordTASDiagnostic({ event, reason: 'early', attempt: 1, hardReload: true });
                assert.equal(window.__tasDiagnostics.current.recoveryOutcome, null, 'new recovery retained stale outcome');
            });
        }

        test('synthetic resilience: unchanged backup selections do not flood diagnostics in ' + file, () => {
            const window = { __tasDiagnostics: { startedAt: Date.now(), current: {}, events: [], render() {} } };
            const context = createScriptContext(readScript(file), { window });
            for (let i = 0; i < 150; i++) context.recordTASDiagnostic({ event: 'backup-selected', playerType: 'autoplay', quality: '640x360' });
            assert.equal(window.__tasDiagnostics.events.length, 1);
            context.recordTASDiagnostic({ event: 'ad-end' });
            context.recordTASDiagnostic({ event: 'backup-selected', playerType: 'autoplay', quality: '640x360' });
            assert.equal(window.__tasDiagnostics.events.length, 3);
        });
    }
}

for (const file of ['vaft/vaft.user.js', 'vaft/vaft-ublock-origin.js']) {
    function pageContext() {
        const window = { location: { href: 'https://www.twitch.tv/currentchan' },
            __tasDiagnostics: { script: 'vaft', version: 'fixture', startedAt: Date.now(), current: {}, events: [], render() {} } };
        const context = createScriptContext(readScript(file), { window, URL, console: { log() {} } });
        return { window, context };
    }

    test('synthetic resilience: AD DEBUG console lines are kept in a bounded buffer in ' + file, () => {
        const { window, context } = pageContext();
        for (let i = 0; i < 200; i++) context.tasLog('[AD DEBUG] line ' + i + ' ' + 'x'.repeat(500));
        const logs = window.__tasDiagnostics.logs;
        assert.equal(logs.length, 150);
        assert.ok(logs[0].text.startsWith('[AD DEBUG] line 50 '));
        assert.ok(logs.every(entry => entry.text.length <= 400));
        context.tasLog('[AD DEBUG] failed:', new Error('boom'));
        assert.equal(window.__tasDiagnostics.logs.at(-1).text, '[AD DEBUG] failed: boom');
    });

    test('synthetic resilience: worker AD DEBUG lines are posted to the page in ' + file, () => {
        const messages = [];
        const context = createScriptContext(readScript(file), { console: { log() {} }, postMessage: message => messages.push(message) });
        context.tasLog('[AD DEBUG] Backup stream (embed) also has ads');
        assert.deepEqual(JSON.parse(JSON.stringify(messages)), [{ key: 'TASLog', text: '[AD DEBUG] Backup stream (embed) also has ads' }]);
    });

    test('synthetic resilience: console lines in the export hide channels, URLs and tokens in ' + file, () => {
        const { window, context } = pageContext();
        const lines = [
            '[AD DEBUG] New stream session — channel: SecretStreamer, API: v2',
            '[AD DEBUG] CSAI ad request (fetch) — type: video on otherstreamer with NO break detected',
            '[AD DEBUG] Ad segment detected via URL pattern: https://video-edge-1.abs.hls.ttvnw.net/v1/segment/privatepath.ts?sig=deadbeef',
            '[AD DEBUG] Access token HTTP 403 for embed — {"token":"privatetoken","signature":"privatesig"}',
            '[AD DEBUG] Worker reused blob:https://www.twitch.tv/private-uuid',
            '[AD DEBUG] header Authorization: OAuth privateoauth and eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl',
            '[AD DEBUG] opaque abcdefghijklmnopqrstuvwxyz0123456789ABCDEF',
            '[AD DEBUG] Ad detected on currentchan and SECRETSTREAMER again'
        ];
        for (const line of lines) context.tasLog(line);
        const report = context.getTASDiagnostics();
        const json = JSON.stringify(report.consoleLog);
        for (const privateValue of ['SecretStreamer', 'SECRETSTREAMER', 'otherstreamer', 'currentchan', 'privatepath', 'deadbeef',
            'privatetoken', 'privatesig', 'private-uuid', 'privateoauth', 'eyJhbGci', 'abcdefghijklmnopqrstuvwxyz']) {
            assert.ok(!json.includes(privateValue), 'console export leaked ' + privateValue);
        }
        assert.equal(report.consoleLog[0].text, '[AD DEBUG] New stream session — channel: <channel>, API: v2');
        assert.ok(report.consoleLog[2].text.includes('https://video-edge-1.abs.hls.ttvnw.net/<redacted>'));
        assert.ok(window.__tasDiagnostics.logs[0].text.includes('SecretStreamer'), 'redaction must not alter the stored line');
    });
}
