const test = require('node:test');
const assert = require('node:assert/strict');
const { readScript, createScriptContext } = require('./scripts');

const files = ['vaft/vaft.user.js', 'vaft/vaft-ublock-origin.js'];
const clean = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:100\n#EXTINF:2.000,live\nhttps://fixture.invalid/live.ts\n';

function registerStream(context, values = {}) {
    const url = 'https://fixture.invalid/native.m3u8';
    const stream = context.createStreamInfo('fixture', '', '');
    Object.assign(stream, values);
    stream.Urls[url] = { Resolution: '1920x1080', FrameRate: 60, Codecs: 'avc1.4d4028' };
    context.StreamInfosByUrl[url] = stream;
    context.StreamInfos.fixture = stream;
    context.ActiveStreamInfo = stream;
    return { url, stream };
}

function harness(file, bindings = {}) {
    const messages = [];
    const context = createScriptContext(readScript(file), {
        console: { log() {}, error() {} }, URL, Request, Response, Headers, Blob,
        AbortController, DOMException, Uint8Array, atob, setTimeout, clearTimeout,
        postMessage: message => messages.push(message),
        ...bindings
    });
    return { context, messages };
}

function recoveryHarness(file) {
    let now = 100000, timerId = 0;
    const timers = new Map(), storage = new Map(), reloads = [], listeners = new Map();
    const window = { location: { href: 'https://www.twitch.tv/fixture' } };
    const { context } = harness(file, {
        window, Date: class extends Date { static now() { return now; } },
        setTimeout(callback, delay) { timers.set(++timerId, { callback, at: now + delay }); return timerId; },
        clearTimeout(id) { timers.delete(id); },
        localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
        document: {
            pictureInPictureElement: null,
            addEventListener(name, listener) { listeners.set(name, listener); },
            removeEventListener(name) { listeners.delete(name); }
        },
        playerBufferState: { userPauseIntent: false }, localStorageHookFailed: false,
        iosSoftReload: false, playerForMonitoringBuffering: null
    });
    const makePlayer = () => {
        const video = { currentTime: 10, readyState: 2, muted: true, paused: false, ended: false, buffered: { length: 0 } };
        return { video, core: {}, plays: 0, getHTMLVideoElement: () => video, isPaused: () => video.paused,
            pause() { video.paused = true; }, play() { this.plays++; video.paused = false; return Promise.resolve(); } };
    };
    const current = { player: makePlayer(), state: { props: { content: { type: 'live' } }, setSrc: options => reloads.push(options) } };
    context.getPlayerAndState = () => current;
    context.postTwitchWorkerMessage = () => {};
    context.startDriftCorrection = () => {};
    function advance(ms) {
        const until = now + ms;
        while (true) {
            const next = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
            if (!next) break;
            now = next[1].at;
            timers.delete(next[0]);
            next[1].callback();
        }
        now = until;
    }
    return { context, current, makePlayer, advance, storage, reloads, window, listeners };
}

function monitorHarness(file, hasPlayed = true) {
    const h = recoveryHarness(file);
    Object.assign(h.context, {
        isActivelyStrippingAds: false, DisablePostBreakWedge: true,
        hideTwitchAdOverlays() {}, updateAdblockBanner() {}
    });
    Object.assign(h.context.playerBufferState, {
        lastFixTime: 0, lastBackupSwitchAt: 0, lastReloadAt: 0,
        gapJumpLastPosition: -1, gapJumpStuckTicks: 0
    });
    Object.assign(h.current.player, {
        getState: () => 'Playing', getBufferDuration: () => 30
    });
    h.current.player.core.state = {
        position: 10, bufferedPosition: 40,
        path: 'https://usher.ttvnw.net/api/v2/channel/hls/fixture.m3u8?token=fixture'
    };
    Object.assign(h.current.player.video, {
        readyState: 4, networkState: 1, seeking: false,
        addEventListener() {}, buffered: { length: 1, start: () => 0, end: () => 40 }
    });
    h.current.state.setSrc = options => {
        h.reloads.push(options);
        h.current.player.video.buffered = { length: 0 };
        h.current.player.video.readyState = 1;
    };
    h.context.monitorPlayerBuffering();
    if (hasPlayed) h.current.player.video.currentTime++;
    h.advance(600);
    return h;
}

for (const file of files) {
    for (const layout of ['empty', 'edge', 'gap']) {
        test('synthetic resilience: ' + file + ' fast depleted-buffer recovery for ' + layout, () => {
            const h = monitorHarness(file);
            h.context.playerBufferState.inAdBreak = true;
            h.advance(600);
            h.context.playerBufferState.inAdBreak = false;
            const video = h.current.player.video;
            video.readyState = 2;
            video.buffered = layout === 'empty' ? { length: 0 } : layout === 'gap'
                ? { length: 1, start: () => video.currentTime + 5, end: () => video.currentTime + 15 }
                : { length: 1, start: () => 0, end: () => video.currentTime + 0.001 };
            h.advance(3000);
            assert.equal(h.reloads.length, 0, 'must allow the full three-second observation window');
            h.advance(1200);
            assert.equal(h.reloads.length, 1, 'depleted buffer did not recover within four seconds plus monitor cadence');
            h.context.doTwitchPlayerTask.recovery.cancel();
        });
    }

    test('synthetic resilience: ' + file + ' retains the longer watchdog for usable buffered media', () => {
        const h = monitorHarness(file);
        h.context.playerBufferState.inAdBreak = true;
        h.advance(600);
        h.context.playerBufferState.inAdBreak = false;
        h.current.player.video.readyState = 2;
        h.advance(7000);
        assert.equal(h.reloads.length, 0);
        h.advance(2400);
        assert.equal(h.reloads.length, 1);
        h.context.doTwitchPlayerTask.recovery.cancel();
    });

    test('synthetic resilience: ' + file + ' starts a required reset despite stale paused internals', () => {
        const h = recoveryHarness(file);
        h.current.player.video.paused = true;
        h.current.player.isPaused = () => false;
        h.current.player.core.paused = true;
        h.context.doTwitchPlayerTask(false, true, 'early');
        assert.equal(h.reloads.length, 1, 'stale paused internals blocked the required reset');
        h.context.doTwitchPlayerTask.recovery.cancel();
    });

    test('synthetic resilience: ' + file + ' recovers an involuntarily paused post-ad video', () => {
        const h = monitorHarness(file);
        h.context.playerBufferState.inAdBreak = true;
        h.advance(600);
        h.context.playerBufferState.inAdBreak = false;
        Object.assign(h.current.player.video, { paused: true, readyState: 2, networkState: 2,
            buffered: { length: 1, start: () => 0, end: () => h.current.player.video.currentTime + 0.001 } });
        h.current.player.isPaused = () => false;
        h.current.player.core.paused = true;
        h.advance(9000);
        assert.equal(h.reloads.length, 1, 'native pause mismatch suppressed the post-ad watchdog');
        h.context.doTwitchPlayerTask.recovery.cancel();
    });

    test('synthetic resilience: ' + file + ' keeps retries bounded when play leaves the video paused', async () => {
        const h = recoveryHarness(file);
        h.context.doTwitchPlayerTask(false, true, 'early');
        h.current.player.video.paused = true;
        h.current.player.core.paused = true;
        h.current.player.isPaused = () => false;
        h.current.player.play = () => Promise.resolve();
        h.advance(13000);
        assert.equal(h.reloads.length, 2, 'paused internals cancelled recovery before its retry');
        assert.equal(await h.context.doTwitchPlayerTask.latestRecovery.promise, false);
    });

    test('synthetic resilience: ' + file + ' preserves a wrapper-confirmed pause without an intent event', () => {
        const h = recoveryHarness(file);
        h.current.player.video.paused = true;
        h.current.player.core.paused = true;
        h.context.doTwitchPlayerTask(false, true, 'early');
        assert.equal(h.reloads.length, 0);
        assert.equal(h.current.player.plays, 0);
    });

    test('synthetic resilience: ' + file + ' required reset still respects explicit user pause', () => {
        const h = recoveryHarness(file);
        h.window.__tasDiagnostics = { startedAt: 100000, current: {}, events: [], render() {} };
        h.context.playerBufferState.userPauseIntent = true;
        h.current.player.core.paused = true;
        h.context.doTwitchPlayerTask(false, true, 'early');
        assert.equal(h.reloads.length, 0);
        assert.equal(h.current.player.plays, 0);
        assert.equal(h.window.__tasDiagnostics.events.at(-1).reason, 'user-pause');
        assert.equal(h.window.__tasDiagnostics.current.recoveryOutcome, 'blocked-user-pause');
    });

    for (const replacementAt of ['before-end', 'at-end', 'after-end']) {
        test('synthetic resilience: ' + file + ' preserves post-ad recovery across replacement ' + replacementAt, () => {
            const h = monitorHarness(file);
            h.context.playerBufferState.inAdBreak = true;
            h.advance(600);
            const replace = () => {
                h.current.player.video = { ...h.current.player.video, currentTime: 0, readyState: 1, buffered: { length: 0 } };
                h.current.player.getHTMLVideoElement = () => h.current.player.video;
            };
            if (replacementAt === 'before-end') { replace(); h.advance(600); }
            h.context.playerBufferState.inAdBreak = false;
            if (replacementAt === 'at-end') replace();
            h.advance(600);
            const deadline = h.context.playerBufferState.adPlaybackWatch.postBreakUntil;
            if (replacementAt === 'after-end') replace();
            h.advance(4800);
            assert.equal(h.reloads.length, 1, 'replacement lost the post-ad recovery context');
            assert.equal(h.context.playerBufferState.adPlaybackWatch.postBreakUntil, deadline, 'replacement extended the watch');
            h.advance(15000);
            replace();
            h.advance(60000);
            assert.equal(h.reloads.length, 2, 'replacement re-armed an exhausted recovery');
        });
    }

    test('synthetic resilience: ' + file + ' exports observed recovery outcomes and safe playback state', async () => {
        const h = recoveryHarness(file);
        h.window.__tasDiagnostics = { script: 'vaft', version: 'fixture', startedAt: 100000,
            current: {}, events: [], render() {} };
        h.context.isActivelyStrippingAds = false;
        h.current.player.core.state = { path: 'https://private.invalid/token=secret' };
        h.current.player.video.networkState = 2;
        h.current.player.video.error = { code: 3, message: 'secret media error' };
        const recovery = h.context.doTwitchPlayerTask(false, true, 'early');
        h.advance(13000);
        assert.equal(await recovery, false);
        const report = h.context.getTASDiagnostics();
        assert.equal(report.events.filter(event => event.event === 'reload-start').length, 2);
        assert.deepEqual(JSON.parse(JSON.stringify(report.events.at(-1))), {
            atMs: 12000, event: 'recovery-finished', success: false, reason: 'timeout', attempt: 2
        });
        assert.equal(report.playback.available, true);
        assert.equal(report.playback.recoveryActive, false);
        assert.equal(report.playback.networkState, 2);
        assert.equal(report.playback.mediaErrorCode, 3);
        assert.ok(!JSON.stringify(report).includes('secret'));
        assert.ok(!JSON.stringify(report).includes('private.invalid'));
    });

    test('synthetic resilience: ' + file + ' recovers a depleted frozen video after the ad ends', () => {
        const h = monitorHarness(file);
        h.context.playerBufferState.inAdBreak = true;
        h.current.player.video.readyState = 1;
        h.current.player.video.buffered = { length: 0 };
        h.advance(600);
        h.context.playerBufferState.inAdBreak = false;
        h.context.playerBufferState.lastBackupSwitchAt = 101200;
        h.advance(15000);
        assert.equal(h.reloads.length, 1, 'post-ad depleted freeze never requested recovery');
        h.advance(60000);
        assert.equal(h.reloads.length, 2, 'only one bounded recovery runs for a frozen post-ad video');
    });

    test('synthetic resilience: ' + file + ' post-ad freeze watch respects pause, seek, progress and navigation', () => {
        for (const reason of ['pause', 'intent', 'seek', 'progress', 'channel', 'startup']) {
            const h = monitorHarness(file, reason !== 'startup');
            h.context.playerBufferState.inAdBreak = true;
            h.advance(600);
            h.context.playerBufferState.inAdBreak = false;
            h.current.player.video.readyState = 1;
            if (reason === 'pause') h.current.player.video.paused = true;
            if (reason === 'intent') h.context.playerBufferState.userPauseIntent = true;
            if (reason === 'seek') h.current.player.video.seeking = true;
            if (reason === 'channel') h.window.location.href = 'https://www.twitch.tv/other';
            for (let i = 0; i < 100; i++) {
                if (reason === 'progress') h.current.player.video.currentTime += 0.5;
                h.advance(600);
            }
            assert.equal(h.reloads.length, 0, reason);
        }
    });

    test('synthetic resilience: ' + file + ' recovers a frozen ad backup without stripped segments or buffer gaps', async () => {
        for (const readyState of [2, 4]) {
            const h = monitorHarness(file);
            h.context.playerBufferState.inAdBreak = true;
            h.current.player.video.readyState = readyState;
            h.advance(7800);
            assert.equal(h.reloads.length, 0, 'short stalls do not reload');
            h.advance(1200);
            assert.equal(h.reloads.length, 1, 'frozen playhead triggers recovery, readyState=' + readyState);
            assert.equal(h.reloads[0].isNewMediaPlayerInstance, true);
            assert.equal(h.reloads[0].refreshAccessToken, true);
            h.advance(30000);
            assert.equal(h.reloads.length, 2, 'only the bounded recovery retries the same frozen video');
            assert.equal(await h.context.doTwitchPlayerTask.latestRecovery.promise, false);
        }
    });

    test('synthetic resilience: ' + file + ' gives ad switches and reloads grace before frozen-playhead recovery', () => {
        for (const [field, delay] of [['lastBackupSwitchAt', 10000], ['lastReloadAt', 15000]]) {
            const h = monitorHarness(file);
            h.context.playerBufferState.inAdBreak = true;
            h.context.playerBufferState[field] = 100600;
            h.advance(delay + 7200);
            assert.equal(h.reloads.length, 0, field);
            h.advance(2400);
            assert.equal(h.reloads.length, 1, field);
            h.context.doTwitchPlayerTask.recovery.cancel();
        }
    });

    test('synthetic resilience: ' + file + ' re-arms ad stall recovery only after playback resumes beyond reload grace', () => {
        const h = monitorHarness(file);
        h.context.playerBufferState.inAdBreak = true;
        h.advance(9000);
        h.context.doTwitchPlayerTask.recovery.cancel();
        h.advance(16000);
        assert.equal(h.reloads.length, 1);
        h.current.player.video.currentTime++;
        h.current.player.video.readyState = 4;
        h.advance(600);
        h.advance(9000);
        assert.equal(h.reloads.length, 2);
        h.context.doTwitchPlayerTask.recovery.cancel();
    });

    test('synthetic resilience: ' + file + ' excludes paused, seeking, ended, VOD and moving playback from ad stall recovery', () => {
        for (const reason of ['pause', 'wrapper-pause', 'intent', 'seek', 'ended', 'vod', 'progress', 'outside-ad', 'replacement', 'channel', 'startup']) {
            const h = monitorHarness(file, reason !== 'startup');
            h.context.playerBufferState.inAdBreak = reason !== 'outside-ad';
            if (reason === 'pause') h.current.player.video.paused = true;
            if (reason === 'wrapper-pause') h.current.player.isPaused = () => true;
            if (reason === 'intent') h.context.playerBufferState.userPauseIntent = true;
            if (reason === 'seek') h.current.player.video.seeking = true;
            if (reason === 'ended') h.current.player.video.ended = true;
            if (reason === 'vod') h.current.state.props.content.type = 'video';
            if (reason === 'replacement') h.current.player.video = { ...h.current.player.video };
            if (reason === 'replacement') h.current.player.getHTMLVideoElement = () => h.current.player.video;
            if (reason === 'channel') h.window.location.href = 'https://www.twitch.tv/other';
            for (let tick = 0; tick < 40; tick++) {
                if (reason === 'progress') h.current.player.video.currentTime += 0.5;
                h.advance(600);
            }
            assert.equal(h.reloads.length, 0, reason);
        }
    });

    test('synthetic resilience: ' + file + ' keeps early reload budgets on sticky and backup-search paths', async () => {
        for (const sticky of [false, true]) {
            for (const [cacheSize, threshold, expected] of [[0, 3, 2], [3, 3, 1], [0, 0, 0]]) {
                const { context, messages } = harness(file);
                context.BackupPlayerTypes = [];
                context.PreferLowQualityBackup = false;
                context.EarlyReloadPollThreshold = threshold;
                const { url, stream } = registerStream(context, {
                    IsShowingAd: true, CsaiOnlyThisBreak: sticky,
                    RecoverySegments: Array.from({ length: cacheSize }, (_, index) => ({
                        extinf: '#EXTINF:2.000,live', url: 'https://fixture.invalid/cached-' + index + '.ts'
                    }))
                });
                const ads = '#EXTM3U\n#EXT-X-DATERANGE:CLASS="twitch-stitched-ad",TYPE="MIDROLL"\n#EXT-X-MEDIA-SEQUENCE:100\n#EXTINF:2.000,ad\nhttps://fixture.invalid/stitched-ad.ts\n';
                for (let poll = 0; poll < 5; poll++) await context.processM3U8(url, ads, null);
                const reloads = messages.filter(message => message.key === 'ReloadPlayer');
                assert.equal(reloads.length, expected, 'sticky=' + sticky + ', cache=' + cacheSize + ', threshold=' + threshold);
                assert.equal(stream.EarlyReloadCount, expected);
                assert.ok(reloads.every(message => message.kind === 'early'));
            }
        }
    });

    test('synthetic resilience: ' + file + ' preserves post-ad actions for backups, stripping and cycle rescue', async () => {
        for (const [values, expected] of [
            [{}, null],
            [{ LastCommittedBackupPlayerType: 'autoplay' }, 'ReloadPlayer'],
            [{ NumStrippedAdSegments: 4 }, 'ReloadPlayer'],
            [{ NumStrippedAdSegments: 4, CycleRescuedThisBreak: true, TotalAllStrippedPolls: 2 }, 'PauseResumePlayer'],
            [{ NumStrippedAdSegments: 4, CycleRescuedThisBreak: true, TotalAllStrippedPolls: 3 }, 'ReloadPlayer']
        ]) {
            const { context, messages } = harness(file);
            const { url, stream } = registerStream(context, {
                IsShowingAd: true, HasConfirmedAdAttrs: true, CleanPlaylistCount: 2, ...values
            });
            await context.processM3U8(url, clean, null);
            const actions = messages.filter(message => ['ReloadPlayer', 'PauseResumePlayer'].includes(message.key));
            assert.deepEqual(actions.map(message => message.key), expected ? [expected] : []);
            if (expected === 'ReloadPlayer') assert.equal(actions[0].kind, 'early');
            assert.equal(stream.IsShowingAd, false);
            assert.equal(stream.PendingAdEndAt, 0);
            assert.equal(stream.LastCleanSignature, null);
        }
    });

    test('synthetic resilience: ' + file + ' honors post-ad buffer resets despite healthy playback signals', async () => {
        for (const stripped of [false, true]) {
            for (const ios of [false, true]) {
                const worker = harness(file);
                const { url } = registerStream(worker.context, {
                    IsShowingAd: true, HasConfirmedAdAttrs: true, CleanPlaylistCount: 2,
                    LastCommittedBackupPlayerType: stripped ? 'popout' : 'autoplay',
                    NumStrippedAdSegments: stripped ? 4 : 0
                });
                await worker.context.processM3U8(url, clean, null);
                const message = worker.messages.find(message => message.key === 'ReloadPlayer');
                assert.equal(message.kind, 'early');

                const h = recoveryHarness(file), skipped = [];
                h.context.iosSoftReload = ios;
                h.context.postTwitchWorkerMessage = key => skipped.push(key);
                Object.assign(h.current.player.video, { readyState: 4, seekable: { length: 1, end: () => 13 } });
                const pending = h.context.doTwitchPlayerTask(false, true, message.kind);
                assert.equal(h.reloads.length, 1);
                assert.equal(h.reloads[0].isNewMediaPlayerInstance, !ios);
                assert.equal(h.reloads[0].refreshAccessToken, true);
                assert.ok(!skipped.includes('ReloadSkipped'));
                h.context.doTwitchPlayerTask.recovery.cancel();
                assert.equal(await pending, false);
            }
        }
    });

    test('synthetic resilience: ' + file + ' still skips optional reloads when playback is near live', () => {
        for (const kind of [undefined, 'post-ad']) {
            const h = recoveryHarness(file), messages = [];
            h.context.postTwitchWorkerMessage = key => messages.push(key);
            Object.assign(h.current.player.video, { readyState: 4, seekable: { length: 1, end: () => 13 } });
            assert.equal(h.context.doTwitchPlayerTask(false, true, kind), undefined);
            assert.equal(h.reloads.length, 0);
            assert.deepEqual(messages, ['ReloadSkipped']);
        }
    });

    test('synthetic resilience: ' + file + ' upgrades a shared soft recovery before accepting playback progress', async () => {
        const h = recoveryHarness(file);
        const pending = h.context.doTwitchPlayerTask(false, true, 'post-ad');
        h.advance(150);
        h.current.player.video.currentTime++;
        assert.equal(h.context.doTwitchPlayerTask(false, true, 'early'), pending);
        h.advance(150);
        assert.equal(h.reloads.length, 2);
        assert.equal(h.reloads[0].refreshAccessToken, false);
        assert.equal(h.reloads[1].isNewMediaPlayerInstance, true);
        assert.equal(h.reloads[1].refreshAccessToken, true);
        h.advance(150);
        h.current.player.video.currentTime++;
        h.advance(150);
        assert.equal(await pending, true);
    });

    test('synthetic resilience: ' + file + ' permits only one late upgrade after two soft attempts', async () => {
        const h = recoveryHarness(file);
        const pending = h.context.doTwitchPlayerTask(false, true, 'post-ad');
        h.advance(6000);
        assert.equal(h.reloads.length, 2);
        for (let request = 0; request < 5; request++) {
            assert.equal(h.context.doTwitchPlayerTask(false, true, 'early'), pending);
        }
        h.advance(150);
        assert.equal(h.reloads.length, 3);
        assert.equal(h.reloads[2].isNewMediaPlayerInstance, true);
        h.advance(13000);
        assert.equal(await pending, false);
        assert.equal(h.reloads.length, 3);
    });

    test('synthetic resilience: ' + file + ' keeps iOS token refresh separate when upgrading recovery', async () => {
        const h = recoveryHarness(file);
        h.context.iosSoftReload = true;
        const pending = h.context.doTwitchPlayerTask(false, true, 'post-ad');
        h.context.doTwitchPlayerTask(false, true, 'early');
        h.advance(150);
        assert.equal(h.reloads[1].isNewMediaPlayerInstance, false);
        assert.equal(h.reloads[1].refreshAccessToken, true);
        h.context.doTwitchPlayerTask.recovery.cancel();
        assert.equal(await pending, false);
    });

    test('synthetic resilience: ' + file + ' rolls back its pre-mute after a failed reload', async () => {
        const h = recoveryHarness(file);
        h.current.player.video.muted = false;
        h.current.state.setSrc = () => { throw new Error('fixture setSrc failure'); };
        assert.equal(await h.context.doTwitchPlayerTask(false, true, 'early'), false);
        assert.equal(h.current.player.video.muted, false);
        assert.equal(h.listeners.size, 0);
        h.advance(13000);
        assert.equal(h.current.player.video.muted, false);
    });

    test('synthetic resilience: ' + file + ' only rolls back mute changes owned by the cancelled recovery', async () => {
        for (const reason of ['pause', 'pip', 'mute', 'replacement', 'navigation', 'already-muted']) {
            const h = recoveryHarness(file);
            const original = h.current.player.video;
            original.muted = reason === 'already-muted';
            const pending = h.context.doTwitchPlayerTask(false, true, 'early');
            if (reason === 'pause') h.context.playerBufferState.userPauseIntent = true;
            if (reason === 'pip') h.context.document.pictureInPictureElement = {};
            if (reason === 'mute') h.storage.set('video-muted', '{"default":true}');
            if (reason === 'replacement') h.current.player = h.makePlayer();
            if (reason === 'navigation') h.window.location.href = 'https://www.twitch.tv/other';
            h.context.doTwitchPlayerTask.recovery.cancel();
            assert.equal(await pending, false);
            assert.equal(original.muted, !['pause', 'pip'].includes(reason), reason);
            h.advance(13000);
            assert.equal(original.muted, !['pause', 'pip'].includes(reason), reason + ' delayed callbacks');
            if (reason === 'replacement') assert.equal(h.current.player.video.muted, true);
        }
    });

    test('synthetic resilience: ' + file + ' waits through temporary player removal during replacement', async () => {
        const h = recoveryHarness(file);
        const pending = h.context.doTwitchPlayerTask(false, true, 'early');
        h.context.getPlayerAndState = () => null;
        h.advance(450);
        assert.equal(h.context.doTwitchPlayerTask.recovery.promise, pending);
        h.current.player = h.makePlayer();
        h.context.getPlayerAndState = () => h.current;
        h.advance(150);
        assert.equal(h.current.player.plays, 1);
        h.current.player.video.currentTime++;
        h.advance(150);
        assert.equal(await pending, true);
        assert.equal(h.reloads.length, 1);
    });

    test('synthetic resilience: ' + file + ' forwards ordinary worker Request inputs without losing options', async () => {
        const calls = [];
        const { context } = harness(file, { fetch: async (...args) => { calls.push(args); return new Response('{}'); } });
        context.hookWorkerFetch();
        const request = new Request('https://fixture.invalid/passthrough', { method: 'POST', headers: { 'X-Fixture': 'kept' }, body: '{}' });
        await context.fetch(request);
        assert.equal(calls[0][0], request);
        assert.equal(calls[0][0].headers.get('X-Fixture'), 'kept');
        assert.equal(request.bodyUsed, false);
    });

    test('synthetic resilience: ' + file + ' ignores a master response superseded by another channel', async () => {
        const pending = new Map();
        const { context } = harness(file, { fetch: input => new Promise(resolve => pending.set(String(input), resolve)) });
        context.hookWorkerFetch();
        const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,CODECS="avc1.4d4028"\nhttps://fixture.invalid/variant\n';
        const firstUrl = 'https://usher.ttvnw.net/api/channel/hls/first.m3u8?token=fixture';
        const secondUrl = 'https://usher.ttvnw.net/api/channel/hls/second.m3u8?token=fixture';
        const first = context.fetch(firstUrl), second = context.fetch(secondUrl);
        pending.get(secondUrl)(new Response(master));
        await second;
        pending.get(firstUrl)(new Response(master));
        await first;
        assert.equal(context.ActiveStreamInfo.ChannelName, 'second');
        assert.equal(context.StreamInfos.first, undefined);
        assert.equal(context.StreamInfosByUrl['https://fixture.invalid/variant'].ChannelName, 'second');
    });

    test('synthetic resilience: ' + file + ' expires a token relay when the main thread never responds', async () => {
        const timers = new Map();
        let id = 0;
        const { context, messages } = harness(file, {
            setTimeout(callback, delay) { timers.set(++id, { callback, delay }); return id; },
            clearTimeout(timer) { timers.delete(timer); }, pendingFetchRequests: new Map()
        });
        const pending = context.getAccessToken('fixture', 'popout', 1750);
        assert.equal(messages[0].value.timeout, 1750);
        const timer = [...timers.values()][0];
        assert.equal(timer.delay, 1750);
        timer.callback();
        await assert.rejects(pending, /timed out/);
        assert.equal(context.pendingFetchRequests.size, 0);
    });

    test('synthetic resilience: ' + file + ' recovers playback when localStorage is unavailable', async () => {
        const h = recoveryHarness(file);
        h.context.localStorage.getItem = () => { throw new Error('storage blocked'); };
        const pending = h.context.doTwitchPlayerTask(false, true, 'early');
        h.advance(150);
        h.current.player.video.currentTime++;
        h.advance(150);
        assert.equal(await pending, true);
        h.advance(5500);
        assert.equal(h.reloads.length, 1);
    });

    test('synthetic resilience: ' + file + ' coalesces reloads and resumes the replacement player', async () => {
        const { context, current, makePlayer, advance, reloads } = recoveryHarness(file);
        const oldPlayer = current.player;
        const result = context.doTwitchPlayerTask(false, true, 'early');
        assert.equal(context.doTwitchPlayerTask(false, true, 'early'), result);
        const replacement = makePlayer();
        replacement.video.paused = true;
        current.player = replacement;
        advance(150);
        assert.equal(oldPlayer.plays, 0);
        assert.equal(replacement.plays, 1);
        replacement.video.currentTime += 1;
        advance(150);
        assert.equal(await result, true);
        assert.equal(reloads.length, 1);
        assert.equal(context.doTwitchPlayerTask.recovery, null);
    });

    test('synthetic resilience: ' + file + ' bounds player recovery and stops for navigation, pause and PiP', async () => {
        const stalled = recoveryHarness(file);
        const result = stalled.context.doTwitchPlayerTask(false, true, 'early');
        stalled.advance(13000);
        assert.equal(await result, false);
        assert.equal(stalled.reloads.length, 2);
        for (const reason of ['channel', 'vod', 'pause', 'pip']) {
            const h = recoveryHarness(file);
            const pending = h.context.doTwitchPlayerTask(false, true, 'early');
            if (reason === 'channel') h.window.location.href = 'https://www.twitch.tv/another';
            if (reason === 'vod') h.current.state.props.content.type = 'video';
            if (reason === 'pause') h.context.playerBufferState.userPauseIntent = true;
            if (reason === 'pip') h.context.document.pictureInPictureElement = {};
            h.advance(13000);
            assert.equal(await pending, false);
            assert.equal(h.reloads.length, 1);
            assert.equal(h.current.player.plays, 0);
        }
        const ios = recoveryHarness(file);
        ios.context.iosSoftReload = true;
        ios.context.doTwitchPlayerTask(false, true, 'early');
        assert.equal(ios.reloads[0].isNewMediaPlayerInstance, false);
        assert.equal(ios.reloads[0].refreshAccessToken, true);
        ios.context.doTwitchPlayerTask.recovery.cancel();
    });

    test('synthetic resilience: ' + file + ' completes recovery across Drops mini-player navigation', async () => {
        for (const startOnDrops of [false, true]) {
            const h = recoveryHarness(file);
            h.current.player.core.state = { path: 'https://usher.ttvnw.net/api/v2/channel/hls/fixture.m3u8?token=fixture' };
            const drops = 'https://www.twitch.tv/drops/inventory';
            if (startOnDrops) h.window.location.href = drops;
            const pending = h.context.doTwitchPlayerTask(false, true, 'early');
            h.window.location.href = startOnDrops ? 'https://www.twitch.tv/fixture' : drops;
            h.advance(150);
            h.current.player.video.currentTime++;
            h.advance(150);
            assert.equal(await pending, true);
            assert.equal(h.current.player.plays, 1);
            assert.equal(h.reloads.length, 1);
            h.advance(3000);
            assert.equal(h.current.player.video.muted, false);
        }
    });

    test('synthetic resilience: ' + file + ' cancels recovery when the Drops mini-player changes channel', async () => {
        const h = recoveryHarness(file);
        h.window.location.href = 'https://www.twitch.tv/drops/inventory';
        h.current.player.core.state = { path: 'https://usher.ttvnw.net/api/channel/hls/fixture.m3u8?token=fixture' };
        const pending = h.context.doTwitchPlayerTask(false, true, 'early');
        h.current.player.core.state.path = 'https://usher.ttvnw.net/api/channel/hls/other.m3u8?token=fixture';
        h.advance(13000);
        assert.equal(await pending, false);
        assert.equal(h.current.player.plays, 0);
        assert.equal(h.reloads.length, 1);
    });

    test('synthetic resilience: ' + file + ' preserves mute and settings changes made during recovery', async () => {
        const h = recoveryHarness(file);
        h.current.player.video.muted = false;
        h.storage.set('volume', '0.8');
        h.storage.set('video-muted', '{"default":false}');
        h.context.doTwitchPlayerTask(false, true, 'early');
        const replacement = h.makePlayer();
        h.current.player = replacement;
        h.storage.set('volume', '0.2');
        h.storage.set('video-muted', '{"default":true}');
        h.advance(5500);
        assert.equal(h.storage.get('volume'), '0.2');
        assert.equal(h.storage.get('video-muted'), '{"default":true}');
        assert.equal(replacement.video.muted, true);
        h.context.doTwitchPlayerTask.recovery.cancel();
    });

    test('synthetic resilience: ' + file + ' ranks backup codec compatibility ahead of resolution', () => {
        const { context } = harness(file);
        const variant = (codec, resolution, name) => '#EXT-X-STREAM-INF:' + (codec ? 'CODECS="' + codec + '",' : '') + 'RESOLUTION=' + resolution + ',FRAME-RATE=60,BANDWIDTH=3000000\nhttps://fixture.invalid/' + name + '\n';
        const hevc = variant('hvc1.1.6.L120', '1920x1080', 'hevc');
        const avc = variant('mp4a.40.2,avc1.4d4028', '1280x720', 'avc');
        const av1 = variant('av01.0.08M.08', '1920x1080', 'av1');
        const unknown = variant(null, '1920x1080', 'unknown');
        const resolution = { Resolution: '1920x1080', FrameRate: 60, Codecs: 'avc1.4d4028' };
        assert.equal(context.getStreamUrlForResolution('#EXTM3U\n' + hevc + unknown + av1 + avc, resolution), 'https://fixture.invalid/avc');
        assert.equal(context.getStreamUrlForResolution('#EXTM3U\n' + hevc + unknown + av1, resolution), 'https://fixture.invalid/unknown');
        assert.equal(context.getStreamUrlForResolution('#EXTM3U\n' + avc + hevc, { ...resolution, Codecs: 'hvc1.1' }), 'https://fixture.invalid/hevc');
        assert.equal(context.getStreamUrlForResolution('#EXTM3U\n' + avc + av1, { ...resolution, Codecs: 'av01.0' }), 'https://fixture.invalid/av1');
        assert.equal(context.getStreamUrlForResolution('#EXTM3U\n' + hevc, resolution), 'https://fixture.invalid/hevc');
    });

    test('synthetic resilience: ' + file + ' uses the pre-reset freeze count for post-ad recovery', async () => {
        for (const polls of [1, 2, 9]) {
            const { context, messages } = harness(file);
            const { url, stream } = registerStream(context, {
                IsShowingAd: true, HasConfirmedAdAttrs: true, CleanPlaylistCount: 2,
                NumStrippedAdSegments: 4, TotalAllStrippedPolls: polls,
                CycleRescuedThisBreak: true, EarlyReloadCount: 0
            });
            await context.processM3U8(url, clean, null);
            assert.equal(stream.IsShowingAd, false);
            assert.equal(stream.TotalAllStrippedPolls, 0);
            assert.equal(messages.filter(message => message.key === 'ReloadPlayer').length, polls > 2 ? 1 : 0);
        }
    });

    test('synthetic resilience: ' + file + ' confirms advancing clean playlists and bounds marker bouncing', async () => {
        let now = 100000;
        const make = () => {
            const { context } = harness(file, { Date: class extends Date { static now() { return now; } } });
            context.BackupSwapFirst = false;
            return { context, ...registerStream(context, { IsShowingAd: true, HasConfirmedAdAttrs: true }) };
        };
        const repeated = make();
        for (let poll = 0; poll < 8; poll++) {
            now += 2500;
            await repeated.context.processM3U8(repeated.url, clean, null);
        }
        assert.equal(repeated.stream.IsShowingAd, true);
        assert.equal(repeated.stream.CleanPlaylistCount, 1);
        for (const sequence of [101, 102]) {
            await repeated.context.processM3U8(repeated.url, clean.replace('SEQUENCE:100', 'SEQUENCE:' + sequence), null);
        }
        assert.equal(repeated.stream.IsShowingAd, false);
        const bounced = make();
        const start = now;
        for (let poll = 0; poll <= 6; poll++) {
            now = start + poll * 2500;
            let text = clean.replace('SEQUENCE:100', 'SEQUENCE:' + (100 + poll));
            if (poll % 2) text = text.replace('#EXT-X-TARGETDURATION', '#EXT-X-DATERANGE:CLASS="twitch-trigger"\n#EXT-X-TARGETDURATION');
            await bounced.context.processM3U8(bounced.url, text, null);
        }
        assert.equal(bounced.stream.IsShowingAd, false);
        const sustained = make();
        await sustained.context.processM3U8(sustained.url, clean, null);
        now += 13000;
        await sustained.context.processM3U8(sustained.url, clean.replace('#EXT-X-TARGETDURATION', '#EXT-X-DATERANGE:CLASS="twitch-trigger"\n#EXT-X-TARGETDURATION'), null);
        assert.equal(sustained.stream.PendingAdEndAt, 0);
        assert.equal(sustained.stream.IsShowingAd, true);
    });

    test('synthetic resilience: ' + file + ' orders playlist state updates and discards obsolete responses', async () => {
        const { context } = harness(file);
        const { url, stream } = registerStream(context);
        const seen = [];
        let release;
        context.processStreamPlaylist = async (url, text) => {
            seen.push(text);
            if (text === 'first') await new Promise(resolve => { release = resolve; });
            if (text === 'error') throw new Error('fixture error');
            return 'processed ' + text;
        };
        const first = context.processM3U8(url, 'first', null, 1, stream);
        await new Promise(setImmediate);
        const second = context.processM3U8(url, 'second', null, 2, stream);
        assert.deepEqual(seen, ['first']);
        release();
        assert.deepEqual(await Promise.all([first, second]), ['processed first', 'processed second']);
        assert.equal(await context.processM3U8(url, 'late first', null, 1, stream), 'processed second');
        await assert.rejects(context.processM3U8(url, 'error', null, 3, stream), /fixture error/);
        assert.equal(await context.processM3U8(url, 'after error', null, 4, stream), 'processed after error');
        registerStream(context);
        const obsolete = await context.processM3U8(url, clean, null, 5, stream);
        assert.match(obsolete, /#EXTM3U/);
        assert.ok(!seen.includes(clean));
    });

    test('synthetic resilience: ' + file + ' rejects replaced-worker and wrong-channel messages and accepts embeds', () => {
        const worker = {}, replaced = {};
        const window = { location: { href: 'https://www.twitch.tv/fixture' } };
        const { context, messages } = harness(file, { window, twitchWorkers: [worker] });
        const { stream } = registerStream(context);
        assert.equal(context.isCurrentStreamMessage(worker, { channelName: 'fixture' }), true);
        assert.equal(context.isCurrentStreamMessage(replaced, { channelName: 'fixture' }), false);
        assert.equal(context.isCurrentStreamMessage(worker, { channelName: 'old' }), false);
        window.location.href = 'https://player.twitch.tv/?channel=fixture&parent=fixture.invalid';
        assert.equal(context.isCurrentStreamMessage(worker, { channelName: 'fixture' }), true);
        context.postStreamMessage(stream, { key: 'ReloadPlayer' });
        assert.equal(messages.length, 1);
        registerStream(context);
        context.postStreamMessage(stream, { key: 'ReloadPlayer' });
        assert.equal(messages.length, 1);
    });

    test('synthetic resilience: ' + file + ' matches Drops messages to the live mini-player source', () => {
        const h = recoveryHarness(file), worker = {}, replaced = {};
        h.context.twitchWorkers = [worker];
        h.window.location.href = 'https://www.twitch.tv/drops/inventory';
        for (const version of ['', 'v2/']) {
            h.current.player.core.state = { path: 'https://usher.ttvnw.net/api/' + version + 'channel/hls/FiXtUrE.m3u8?token=fixture' };
            assert.equal(h.context.isCurrentStreamMessage(worker, { channelName: 'fixture' }), true);
            assert.equal(h.context.isCurrentStreamMessage(worker, { channelName: 'other' }), false);
            assert.equal(h.context.isCurrentStreamMessage(worker, { channelName: 'drops' }), false);
            assert.equal(h.context.isCurrentStreamMessage(replaced, { channelName: 'fixture' }), false);
        }
        for (const path of [undefined, 'https://video-edge.example.net/chunked.m3u8', 'https://usher.ttvnw.net/vod/fixture.m3u8']) {
            h.current.player.core.state.path = path;
            assert.equal(h.context.isCurrentStreamMessage(worker, { channelName: 'fixture' }), false);
        }
        h.current.player.core.state.path = 'https://usher.ttvnw.net/api/channel/hls/fixture.m3u8';
        h.current.state.props.content.type = 'video';
        assert.equal(h.context.isCurrentStreamMessage(worker, { channelName: 'fixture' }), false);
    });

    test('synthetic resilience: ' + file + ' times out backup headers and bodies and rejects invalid playlists', async () => {
        const timers = new Map();
        let id = 0;
        const { context } = harness(file, {
            setTimeout(callback, delay) { timers.set(++id, { callback, delay }); return id; },
            clearTimeout(timer) { timers.delete(timer); }
        });
        for (const body of [false, true]) {
            const pending = context.fetchPlaylist('https://fixture.invalid/backup', async (url, { signal }) => {
                const hang = () => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
                return body ? { status: 200, text: hang } : hang();
            });
            await new Promise(setImmediate);
            assert.equal(timers.size, 1);
            const timer = [...timers.values()][0];
            assert.equal(timer.delay, 4000);
            timer.callback();
            assert.equal(await pending, null);
            assert.equal(timers.size, 0);
        }
        for (const text of ['<html>error</html>', '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=123\nhttps://fixture.invalid/variant']) {
            assert.equal(await context.fetchPlaylist('https://fixture.invalid/backup', async () => new Response(text), 4000, true), null);
        }
        assert.match(await context.fetchPlaylist('https://fixture.invalid/backup', async () => new Response(clean), 4000, true), /#EXTINF:/);
        assert.equal(timers.size, 0);
    });

    test('synthetic resilience: ' + file + ' bounds a backup search and backs off failed searches', async () => {
        let now = 100000, tokens = 0;
        const { context } = harness(file, { Date: class extends Date { static now() { return now; } } });
        const { url, stream } = registerStream(context, { IsShowingAd: true, HasConfirmedAdAttrs: true });
        context.getAccessToken = async (channel, type, timeout) => {
            tokens++;
            assert.ok(timeout > 0 && timeout <= 4000);
            now += timeout;
            throw new Error('fixture timeout');
        };
        const marked = clean.replace('#EXT-X-TARGETDURATION', '#EXT-X-DATERANGE:CLASS="twitch-trigger"\n#EXT-X-TARGETDURATION');
        await context.processM3U8(url, marked, async () => { throw new Error('unexpected fetch'); });
        assert.equal(now, 108000);
        assert.equal(tokens, 2);
        assert.equal(stream.BackupRetryAt, 111000);
        await context.processM3U8(url, marked, async () => { throw new Error('unexpected fetch'); });
        assert.equal(tokens, 2);
        now = 111001;
        await context.processM3U8(url, marked, async () => { throw new Error('unexpected fetch'); });
        assert.ok(tokens > 2);
    });

    test('synthetic resilience: ' + file + ' processes query, v2 and relative media URLs from master playlists', async () => {
        for (const uri of ['https://fixture.invalid/index.m3u8?token=fixture', 'https://fixture.invalid/v1/chunked/stream', '../fixture/chunked?token=fixture']) {
            const masterUrl = 'https://usher.ttvnw.net/api/v2/channel/hls/fixture.m3u8?token=fixture';
            const mediaUrl = new URL(uri, masterUrl).href;
            const master = '#EXTM3U\r\n#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,FRAME-RATE=60,CODECS="avc1.4d4028"\r\n' + uri + '\r\n';
            const calls = [], processed = [];
            const { context } = harness(file, { fetch: async (input, options) => {
                const url = input instanceof Request ? input.url : String(input);
                calls.push({ input, options });
                return new Response(url === masterUrl ? master : clean);
            } });
            context.processM3U8 = async (url, text) => { processed.push(url); return text + '#fixture-processed\n'; };
            context.hookWorkerFetch();
            await context.fetch(masterUrl);
            assert.equal(context.StreamInfos.fixture.ResolutionList.length, 1);
            assert.equal(context.StreamInfos.fixture.ResolutionList[0].Url, mediaUrl);
            const controller = new AbortController();
            const request = new Request(mediaUrl, { headers: { 'X-Fixture': 'preserved' }, signal: controller.signal });
            assert.match(await (await context.fetch(request)).text(), /#fixture-processed/);
            assert.equal(calls.at(-1).input.headers.get('X-Fixture'), 'preserved');
            controller.abort();
            assert.equal(calls.at(-1).input.signal.aborted, true);
            await context.fetch(new URL(mediaUrl));
            await context.fetch(masterUrl);
            assert.equal(context.StreamInfos.fixture.ResolutionList.length, 1);
            assert.deepEqual(processed, [mediaUrl, mediaUrl]);
            assert.ok(calls.every(call => call.input !== undefined));
        }
    });

    test('synthetic resilience: ' + file + ' preserves enhanced variants without resolution during AVC rewriting', async () => {
        for (const codec of ['hvc1.1.6.L120', 'av01.0.08M.08']) {
            const avcUrl = 'https://fixture.invalid/avc.m3u8';
            const enhancedUrl = 'https://fixture.invalid/enhanced.m3u8';
            const unknownUrl = 'https://fixture.invalid/no-resolution.m3u8';
            const enhancedLine = '#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,CODECS="' + codec + '"';
            const unknownLine = '#EXT-X-STREAM-INF:BANDWIDTH=6000000,CODECS="' + codec + '"';
            const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,CODECS="avc1.4d4028"\n'
                + avcUrl + '\n' + enhancedLine + '\n' + enhancedUrl + '\n' + unknownLine + '\n' + unknownUrl + '\n';
            const { context } = harness(file, { fetch: async () => new Response(master) });
            context.hookWorkerFetch();
            const response = await context.fetch('https://usher.ttvnw.net/api/channel/hls/fixture.m3u8');
            assert.equal(await response.text(), master);
            const rewritten = context.StreamInfos.fixture.ModifiedM3U8;
            assert.ok(rewritten.includes(enhancedLine.replace(codec, 'avc1.4d4028') + '\n' + avcUrl));
            assert.ok(!rewritten.includes(enhancedUrl));
            assert.ok(rewritten.includes(unknownLine + '\n' + unknownUrl + '\n'));
        }
    });

    test('synthetic resilience: ' + file + ' rejects media and master playlist failures', async () => {
        for (const url of ['https://fixture.invalid/live.m3u8', 'https://usher.ttvnw.net/api/channel/hls/fixture.m3u8?token=fixture']) {
            const bodyError = new Error('fixture body failed');
            const { context } = harness(file, { fetch: async () => ({ status: 200, text: async () => { throw bodyError; } }) });
            context.hookWorkerFetch();
            await assert.rejects(context.fetch(url), bodyError);
        }
        const { context } = harness(file, { fetch: async () => new Response(clean) });
        context.processM3U8 = async () => { throw new Error('fixture parser failed'); };
        context.hookWorkerFetch();
        await assert.rejects(context.fetch('https://fixture.invalid/live.m3u8'), /fixture parser failed/);
        const response = new Response('unavailable', { status: 503 });
        const failed = harness(file, { fetch: async () => response }).context;
        failed.hookWorkerFetch();
        assert.equal(await failed.fetch('https://fixture.invalid/live.m3u8'), response);
    });

    test('synthetic resilience: ' + file + ' forwards GQL fetch inputs and captures every supported header format', async () => {
        const calls = [], updates = [];
        const window = { fetch: async (...args) => { calls.push(args); return new Response('{}'); } };
        const { context } = harness(file, { window });
        context.postTwitchWorkerMessage = (...args) => updates.push(args);
        context.hookFetch();
        await window.fetch('https://gql.twitch.tv/gql');
        await window.fetch('https://gql.twitch.tv/gql', { method: 'POST', body: '{}' });
        for (const headers of [
            { 'x-device-id': 'fixture', authorization: 'OAuth fixture' },
            new Headers({ 'X-Device-Id': 'fixture', Authorization: 'OAuth fixture' }),
            [['X-Device-Id', 'fixture'], ['Authorization', 'OAuth fixture']]
        ]) {
            context.GQLDeviceID = null;
            await window.fetch(new URL('https://gql.twitch.tv/gql'), { headers });
            assert.equal(context.GQLDeviceID, 'fixture');
        }
        const request = new Request('https://gql.twitch.tv/gql', {
            method: 'POST', headers: { 'Client-Session-Id': 'session' }, body: '{}'
        });
        await window.fetch(request);
        assert.equal(context.ClientSession, 'session');
        assert.equal(calls.length, 6);
        assert.equal(calls.at(-1)[0], request);
        assert.equal(request.bodyUsed, false);
        assert.ok(updates.some(([key]) => key === 'UpdateAuthorizationHeader'));
        const body = JSON.stringify({ operationName: 'PlaybackAccessToken', variables: { playerType: 'site' } });
        await window.fetch('https://gql.twitch.tv/gql', { method: 'POST', body });
        assert.equal(JSON.parse(calls.at(-1)[1].body).variables.playerType, context.ForceAccessTokenPlayerType);
    });
}
