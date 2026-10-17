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
