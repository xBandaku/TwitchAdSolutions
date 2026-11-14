const test = require('node:test');
const assert = require('node:assert/strict');
const { scripts, readScript, createScriptContext } = require('./scripts');

const files = scripts.filter(({ file }) => /^(vaft\/vaft|video-swap-new\/video-swap-new)/.test(file));
for (const { file } of files) {
    function harness(bindings = {}) {
        const window = {};
        const messages = [];
        const context = createScriptContext(readScript(file), {
            window, URL, Response, Request, Headers, AbortController, setTimeout, clearTimeout,
            console: { log() {} }, postMessage: message => messages.push(message), ...bindings
        });
        context.getPlayerAndState = () => null;
        return { context, window, messages };
    }

    test('synthetic resilience: active worker diagnostics require identity and acknowledgement in ' + file, () => {
        const { context } = harness();
        const first = { postMessage() {} }, replacement = { postMessage() {} };
        let active = first;
        context.getPlayerAndState = () => ({ player: { core: { worker: active } } });
        context.hookWindowWorker.workers = new WeakMap([[first, 'intercepted']]);
        assert.equal(context.getTASWorkerStatus(), 'intercepted');
        assert.equal(context.acceptTASWorkerReady(replacement, { key: 'TASWorkerReady', value: 1 }), false);
        assert.equal(context.acceptTASWorkerReady(first, { key: 'TASWorkerReady', value: 0 }), false);
        assert.equal(context.getTASWorkerStatus(), 'intercepted');
        assert.equal(context.acceptTASWorkerReady(first, { key: 'TASWorkerReady', value: 1 }), true);
        assert.equal(context.getTASWorkerStatus(), 'confirmed');
        active = replacement;
        assert.equal(context.getTASWorkerStatus(), 'possible-miss');
        context.acceptTASWorkerReady(first, { key: 'TASWorkerReady', value: 1 });
        assert.equal(context.getTASDiagnostics().current.workerStatus, 'possible-miss', 'old acknowledgement confirmed a replacement');
        active = null;
        assert.equal(context.getTASWorkerStatus(), 'unknown');
        context.getPlayerAndState = () => { throw new Error('Private player inaccessible'); };
        assert.equal(context.getTASWorkerStatus(), 'unknown');
    });

    test('synthetic resilience: early request diagnostics are sanitized bounded and passive in ' + file, () => {
        const { context, window } = harness();
        for (let i = 0; i < 150; i++) {
            context.recordTASDiagnostic({ event: 'request-outcome', stage: i % 2 ? 'master' : 'media',
                outcome: 'http-error', status: 403, durationMs: 999999,
                url: 'https://private.invalid/channel?token=secret', body: 'private-body', error: 'private-error' });
        }
        assert.equal(window.__tasDiagnostics.events.length, 100);
        context.recordTASDiagnostic({ event: 'request-outcome', stage: 'token', outcome: 'api-error', status: 200, durationMs: 1 });
        const count = window.__tasDiagnostics.events.length;
        context.recordTASDiagnostic({ event: 'request-outcome', stage: 'token', outcome: 'api-error', status: 200, durationMs: 2 });
        assert.equal(window.__tasDiagnostics.events.length, count, 'identical adjacent outcomes flooded diagnostics');
        context.recordTASDiagnostic({ event: 'request-outcome', stage: 'private-stage', outcome: 'private-error' });
        const report = context.getTASDiagnostics();
        assert.equal(report.current.lastRequest, 'token: api-error');
        assert.equal(report.events.find(event => event.durationMs === 60000).status, 403);
        for (const secret of ['private.invalid', 'secret', 'private-body', 'private-error', 'private-stage']) {
            assert.ok(!JSON.stringify(report).includes(secret), 'diagnostics leaked ' + secret);
        }
        report.events.length = 0;
        assert.equal(window.__tasDiagnostics.events.length, 100);
        window.__tasDiagnostics.render = () => { throw new Error('UI unavailable'); };
        assert.doesNotThrow(() => context.recordTASDiagnostic({ event: 'request-outcome', stage: 'token', outcome: 'network-error' }));
    });

    test('synthetic resilience: token relay reports outcomes without changing response or requests in ' + file, async () => {
        const { context, window } = harness();
        const cases = [
            [200, '{"data":{"streamPlaybackAccessToken":{"signature":"private","value":"private"}}}', 'ok'],
            [200, '{"streamPlaybackAccessToken":{"signature":"private","value":"private"}}', 'ok'],
            [200, '{"errors":[{"message":"private"}]}', 'api-error'],
            [200, '{}', 'invalid-response'], [200, 'not JSON private', 'invalid-response'],
            [403, 'private', 'http-error']
        ];
        let calls = 0;
        for (const [status, body, outcome] of cases) {
            window.realFetch = async () => { calls++; return new Response(body, { status }); };
            const result = await context.handleWorkerFetchRequest({ id: 'fixture', diagnosticStage: 'token', url: 'https://gql.twitch.tv/gql', options: {} });
            assert.equal(result.status, status);
            assert.equal(result.body, body);
            assert.equal(result.id, 'fixture');
            assert.equal(window.__tasDiagnostics.events.at(-1).outcome, outcome);
        }
        assert.equal(calls, cases.length, 'diagnostics sent extra requests');
        window.realFetch = async () => { throw new TypeError('private network details'); };
        const failure = await context.handleWorkerFetchRequest({ id: 'fixture', diagnosticStage: 'token', options: {} });
        assert.equal(failure.error, 'private network details', 'diagnostics changed caller error');
        assert.equal(window.__tasDiagnostics.events.at(-1).outcome, 'network-error');
        const count = window.__tasDiagnostics.events.length;
        await context.handleWorkerFetchRequest({ id: 'beacon', options: {} });
        assert.equal(window.__tasDiagnostics.events.length, count, 'non-token request reported as token failure');
        window.realFetch = async () => ({ status: 200, text: async () => { throw new Error('private body interrupted'); } });
        const interrupted = await context.handleWorkerFetchRequest({ id: 'fixture', diagnosticStage: 'token', options: {} });
        assert.equal(interrupted.error, 'private body interrupted');
        assert.equal(window.__tasDiagnostics.events.at(-1).outcome, 'body-error');
        assert.equal(window.__tasDiagnostics.events.at(-1).status, 200);
        assert.ok(!JSON.stringify(context.getTASDiagnostics()).includes('private'));
    });

    test('synthetic resilience: playlist diagnostics preserve payloads and errors in ' + file, async () => {
        const { context, messages } = harness();
        const clean = '#EXTM3U\n#EXTINF:2,live\nhttps://cdn.invalid/live.ts\n';
        if (file.startsWith('vaft/')) {
            const result = await context.fetchPlaylist('https://cdn.invalid/index.m3u8?secret', async () => new Response(clean), 100, true);
            assert.equal(result, clean);
            assert.equal(messages.at(-1).outcome, 'ok');
            assert.equal(await context.fetchPlaylist('https://cdn.invalid/index.m3u8', async () => new Response('private invalid body'), 100, true), null);
            assert.equal(messages.at(-1).outcome, 'invalid-response');
            assert.equal(await context.fetchPlaylist('https://cdn.invalid/index.m3u8', async () => new Response('private', { status: 503 }), 100), null);
            assert.equal(messages.at(-1).outcome, 'http-error');
            assert.equal(messages.at(-1).stage, 'master');
            assert.equal(await context.fetchPlaylist('https://cdn.invalid/index.m3u8', async () => { throw new TypeError('private'); }, 100), null);
            assert.equal(messages.at(-1).outcome, 'network-error');
        } else {
            const response = new Response(clean);
            assert.equal(await context.observeTASFetch('media', async () => response, 'https://cdn.invalid/index.m3u8'), response);
            assert.equal(response.bodyUsed, false, 'observer consumed the response');
            assert.equal(messages.length, 0, 'HTTP success reported before body validation');
            assert.equal(await context.readTASPlaylist(response, 'media'), clean);
            assert.equal(messages.at(-1).outcome, 'ok');
            assert.equal(await context.readTASPlaylist(new Response('private invalid body'), 'media'), 'private invalid body');
            assert.equal(messages.at(-1).outcome, 'invalid-response');
            const error = new TypeError('private');
            await assert.rejects(context.observeTASFetch('master', async () => { throw error; }, 'private'), value => value === error);
            assert.equal(messages.at(-1).outcome, 'network-error');
        }
        assert.ok(!JSON.stringify(messages).includes('private'));
        assert.ok(!JSON.stringify(messages).includes('cdn.invalid'));
    });

    test('synthetic resilience: diagnostics distinguish relay timeouts and ignore obsolete workers in ' + file, async () => {
        const { context, window, messages } = harness({
            setTimeout(callback) { queueMicrotask(callback); return 1; }, clearTimeout() {}, twitchWorkers: []
        });
        window.realFetch = async (url, { signal }) => new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
        const request = { id: 'fixture', diagnosticStage: 'token', options: {} };
        const result = await context.handleWorkerFetchRequest(request);
        assert.match(result.error, /timeout/);
        assert.equal(window.__tasDiagnostics.events.at(-1).outcome, 'timeout');
        const before = window.__tasDiagnostics.events.length;
        await context.handleWorkerFetchRequest(request, {});
        assert.equal(window.__tasDiagnostics.events.length, before, 'obsolete worker changed report');
        window.__tasDiagnostics.render = () => { throw new Error('Broken diagnostic UI'); };
        window.realFetch = async () => new Response('{}');
        assert.equal((await context.handleWorkerFetchRequest(request)).body, '{}', 'diagnostic render changed token result');
        if (file.startsWith('vaft/')) {
            assert.equal(await context.fetchPlaylist('https://fixture.invalid/master.m3u8', async (url, { signal }) => new Promise((resolve, reject) => {
                signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            }), 10), null);
            assert.equal(messages.at(-1).outcome, 'timeout');
            assert.equal(messages.at(-1).stage, 'master');
        }
    });
}
