const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { scripts, readScript } = require('./scripts');

const states = new WeakMap();
const cleanPlaylist = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.000,live\nhttps://www.twitch.tv/fixtures/live.ts\n';

const capturedDirectory = path.join(__dirname, 'fixtures/captured');
for (const name of fs.readdirSync(capturedDirectory).filter(file => file.endsWith('.json'))) {
    const capture = JSON.parse(fs.readFileSync(path.join(capturedDirectory, name), 'utf8'));
    for (const file of scripts.filter(script => script.worker).map(script => script.file)) {
        test('captured response: ' + name + ' replays in the injected worker for ' + file, async ({ page, context }, testInfo) => {
            await boot(page, context, file);
            for (const exchange of [capture.master, capture.media]) {
                for (const hop of exchange.response.redirectHistory) {
                    await context.route(url => url.href === hop.url, route => route.fulfill({
                        status: hop.status, headers: { location: hop.location, 'access-control-allow-origin': '*' }
                    }));
                }
                await context.route(url => url.href === exchange.response.finalUrl, route => route.fulfill({
                    status: exchange.response.status, headers: { ...exchange.response.headers, 'access-control-allow-origin': '*' },
                    body: exchange.response.body
                }));
            }
            const result = await page.evaluate(async ({ masterUrl, mediaUrl }) => {
                const source = `
                    (async () => {
                        try {
                            let processed = 0;
                            if (typeof processM3U8 === 'function') {
                                const original = processM3U8;
                                processM3U8 = (...args) => { processed++; return original(...args); };
                            } else {
                                const original = stripAdSegments;
                                stripAdSegments = (...args) => { processed++; return original(...args); };
                            }
                            const master = await fetch(${JSON.stringify(masterUrl)});
                            const masterBody = await master.text();
                            const media = await fetch(${JSON.stringify(mediaUrl)});
                            self.postMessage({ captured: true, masterStatus: master.status, masterBody,
                                mediaStatus: media.status, mediaBody: await media.text(),
                                processed,
                                resolutions: typeof ActiveStreamInfo !== 'undefined' && ActiveStreamInfo ? ActiveStreamInfo.ResolutionList.length : null,
                                rewriteRan: typeof ActiveStreamInfo !== 'undefined' && ActiveStreamInfo ? ActiveStreamInfo.ModifiedM3U8 !== null : false });
                        } catch (error) { self.postMessage({ captured: true, error: error.message }); }
                    })();
                `;
                const worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
                try {
                    return await new Promise((resolve, reject) => {
                        worker.addEventListener('message', event => { if (event.data.captured) resolve(event.data); });
                        worker.addEventListener('error', event => reject(new Error(event.message)), { once: true });
                    });
                } finally { worker.terminate(); }
            }, { masterUrl: capture.master.request.url, mediaUrl: capture.media.request.url });
            expect(result.error).toBeUndefined();
            expect(result.masterStatus).toBe(capture.master.response.status);
            expect(result.mediaStatus).toBe(capture.media.response.status);
            expect(result.masterBody).toContain('#EXTM3U');
            expect(result.mediaBody).toContain('#EXTM3U');
            expect(result.processed).toBeGreaterThan(0);
            if (file.startsWith('vaft/')) {
                expect(result.resolutions).toBe(capture.master.coverage.withResolution);
                expect(result.rewriteRan).toBe(capture.master.coverage.avcWithResolution > 0 && capture.master.coverage.enhancedWithResolution > 0);
            }
            testInfo.annotations.push({ type: 'evidence', description: 'Captured response replay on a synthetic page with a scripted worker consumer and CORS headers. No live playback reproduction.' });
            testInfo.annotations.push({ type: 'coverage', description: 'Enhanced-codec rewrite: ' + (result.rewriteRan ? 'exercised' : 'NOT EXERCISED') });
        });
    }
}

async function boot(page, context, file, url = 'https://www.twitch.tv/fixture-channel') {
    const state = { errors: [], unexpected: [], requests: [], logs: [] };
    states.set(page, state);
    page.on('pageerror', error => state.errors.push(error.message));
    page.on('console', message => state.logs.push(message.type() + ': ' + message.text()));
    await context.route('**/*', async route => {
        const request = route.request();
        const parsed = new URL(request.url());
        state.requests.push(parsed.href);
        if (['blob:', 'data:'].includes(parsed.protocol)) {
            await route.continue();
        } else if (request.isNavigationRequest() && parsed.href === url) {
            await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><div id="root"><div class="video-player"><video></video></div></div></body></html>' });
        } else if (parsed.pathname === '/api/v2/channel/hls/fixture-channel.m3u8') {
            await route.fulfill({ contentType: 'application/vnd.apple.mpegurl', body: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,FRAME-RATE=60,CODECS="avc1.4d4028"\n/fixtures/chunked?token=fixture\n#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,FRAME-RATE=60,CODECS="avc1.4d4028"\n/fixtures/clean.m3u8?token=fixture\n' });
        } else if (['/fixtures/clean.m3u8', '/fixtures/chunked'].includes(parsed.pathname)) {
            await route.fulfill({ contentType: 'application/vnd.apple.mpegurl', body: cleanPlaylist });
        } else if (parsed.pathname.startsWith('/fixtures/passthrough')) {
            await route.fulfill({ status: 207, contentType: 'application/json', headers: { 'x-fixture': 'preserved' }, body: '{"fixture":"passthrough"}' });
        } else if (parsed.pathname === '/fixtures/blocked-ad.ts') {
            await route.fulfill({ contentType: 'video/mp4', body: 'original ad media' });
        } else if (parsed.hostname === 'gql.twitch.tv' && parsed.pathname === '/gql') {
            await route.fulfill({ contentType: 'application/json', body: '{"errors":[{"message":"failed integrity check"}]}' });
        } else if (parsed.pathname === '/favicon.ico') {
            await route.fulfill({ status: 204 });
        } else {
            state.unexpected.push(parsed.href);
            await route.abort('blockedbyclient');
        }
    });
    await page.addInitScript({ content: String.raw`
        window.__nativeFetch = window.fetch;
        window.__nativeWorker = window.Worker;
        window.__gmCalls = [];
        window.__gmFail = false;
        window.__gmPending = false;
        window.__gmAborts = 0;
        window.GM_xmlHttpRequest = options => {
            window.__gmCalls.push({ url: options.url, method: options.method, data: options.data, headers: options.headers });
            queueMicrotask(() => {
                if (window.__gmPending) return;
                if (window.__gmFail) options.onerror({ error: 'fixture transport failure' });
                else options.onload({ status: 200, responseText: '{"data":{"fixture":true}}', responseHeaders: 'content-type: application/json\r\n' });
            });
            return { abort() { window.__gmAborts++; options.onabort(); } };
        };
        window.GM = { xmlHttpRequest: window.GM_xmlHttpRequest };
        Object.defineProperty(navigator, 'brave', { configurable: true, value: { isBrave: async () => true } });
        Object.defineProperty(navigator, 'userAgentData', { configurable: true, value: {
            brands: [{ brand: 'Brave', version: '156' }], mobile: false, platform: 'Windows',
            getHighEntropyValues: async () => ({ brands: [{ brand: 'Brave', version: '156' }], platform: 'Windows', mobile: false })
        } });
        ${readScript(file)}
    ` });
    await page.goto(url);
    return state;
}

async function bootRecovery(page, context, file) {
    test.skip(process.platform === 'win32' && context.browser().browserType().name() === 'webkit',
        'Windows WebKit cannot decode the PCM fixture; native-media recovery runs on Linux CI.');
    await page.clock.install({ time: new Date(100000) });
    await boot(page, context, file);
    await page.evaluate(async () => {
        const samples = 8000 * 20;
        const wave = new Uint8Array(44 + samples * 2);
        const view = new DataView(wave.buffer);
        const label = (offset, text) => [...text].forEach((char, i) => { wave[offset + i] = char.charCodeAt(0); });
        label(0, 'RIFF'); label(8, 'WAVE'); label(12, 'fmt '); label(36, 'data');
        view.setUint32(4, wave.length - 8, true); view.setUint32(16, 16, true);
        view.setUint16(20, 1, true); view.setUint16(22, 1, true);
        view.setUint32(24, 8000, true); view.setUint32(28, 16000, true);
        view.setUint16(32, 2, true); view.setUint16(34, 16, true);
        view.setUint32(40, samples * 2, true);
        let binary = '';
        for (let offset = 0; offset < wave.length; offset += 32768) {
            binary += String.fromCharCode(...wave.subarray(offset, offset + 32768));
        }
        // PCM audio exercises native media state without a hardware video decoder.
        const src = 'data:audio/wav;base64,' + btoa(binary);
        const fixture = window.__recoveryFixture = { reloads: [], players: [], fail: false, userMute: false, retainVideo: false, pip: null };
        Object.defineProperty(document, 'pictureInPictureElement', { configurable: true, get: () => fixture.pip });
        const owner = { setPlayerActive() {}, props: {} };
        const makePlayer = video => {
            video.src = src;
            video.preload = 'auto';
            video.volume = 0;
            video.playsInline = true;
            const player = {
                video, plays: 0, core: { state: { position: 10, bufferedPosition: 40,
                    path: 'https://usher.ttvnw.net/api/v2/channel/hls/fixture-channel.m3u8?token=fixture' } },
                getHTMLVideoElement: () => video, getBufferDuration: () => 30,
                getState: () => video.paused ? 'Paused' : 'Playing', isPaused: () => video.paused,
                pause() { this.core.paused = true; video.pause(); },
                play() { this.core.paused = false; this.plays++; return video.play(); }
            };
            fixture.players.push(player);
            owner.props.mediaPlayerInstance = player;
            fixture.current = player;
            return player;
        };
        const initialVideo = document.querySelector('video');
        makePlayer(initialVideo);
        const state = {
            props: { content: { type: 'live' } }, setInitialPlaybackSettings() {},
            setSrc(options) {
                fixture.reloads.push(options);
                if (fixture.userMute) localStorage.setItem('video-muted', '{"default":true}');
                if (fixture.fail) throw new Error('fixture reload failure');
                if (fixture.retainVideo) return;
                const replacement = document.createElement('video');
                replacement.muted = true;
                fixture.current.video.replaceWith(replacement);
                makePlayer(replacement);
            }
        };
        document.getElementById('root')._reactRootContainer = {
            _internalRoot: { current: { child: { stateNode: owner, sibling: { stateNode: state } } } }
        };
        const ad = document.createElement('video');
        ad.id = 'fixture-ad'; ad.muted = true; document.body.appendChild(ad);
        const start = document.createElement('button');
        start.id = 'fixture-start'; start.textContent = 'Start fixture';
        start.onclick = () => initialVideo.play();
        document.body.appendChild(start);
        const source = `
            self.addEventListener('message', event => {
                if (event.data.fixtureAdBreak || event.data.fixtureAdEnd) {
                    self.postMessage({ key: 'UpdateAdBlockBanner', hasAds: !event.data.fixtureAdEnd, isMidroll: true,
                        isStrippingAdSegments: false, activeBackupPlayerType: 'popout', channelName: 'fixture-channel', sessionId: 1 });
                } else if (event.data.fixtureReload) {
                    self.postMessage({ key: 'ReloadPlayer', kind: event.data.kind, channelName: 'fixture-channel', sessionId: 1 });
                } else return;
                self.postMessage({ fixtureAck: true });
            });
            self.postMessage({ fixtureReady: true });
        `;
        const worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
        await new Promise(resolve => worker.addEventListener('message', event => { if (event.data.fixtureReady) resolve(); }));
        fixture.send = message => new Promise(resolve => {
            const ack = event => {
                if (!event.data.fixtureAck) return;
                worker.removeEventListener('message', ack);
                resolve();
            };
            worker.addEventListener('message', ack);
            worker.postMessage(message);
        });
        fixture.reload = kind => fixture.send({ fixtureReload: true, kind });
        fixture.adBreak = () => fixture.send({ fixtureAdBreak: true });
        fixture.endAdBreak = () => fixture.send({ fixtureAdEnd: true });
    });
    await expect.poll(() => page.evaluate(() => window.__recoveryFixture.current.video.readyState)).toBeGreaterThanOrEqual(2);
    await page.locator('#fixture-start').click();
    await expect.poll(() => page.evaluate(() => window.__recoveryFixture.current.video.paused)).toBe(false);
}

test.afterEach(async ({ page }, testInfo) => {
    const state = states.get(page);
    if (!state) return;
    if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach('browser-console', { body: state.logs.join('\n'), contentType: 'text/plain' });
    }
    expect(state.errors, 'uncaught page errors').toEqual([]);
    expect(state.unexpected, 'requests outside the offline fixture').toEqual([]);
});

for (const script of scripts) {
    if (script.file.startsWith('vaft/vaft')) {
        test('synthetic resilience: ' + script.file + ' exposes a disabled page-refresh option with reset support', async ({ page, context }) => {
            await boot(page, context, script.file);
            await page.getByRole('button', { name: 'Ad blocker settings', exact: true }).click();
            const dialog = page.getByRole('dialog');
            await dialog.getByText('Advanced recovery settings', { exact: true }).click();
            const fallback = dialog.getByLabel('Refresh the page if player recovery fails', { exact: true });
            await expect(fallback).not.toBeChecked();
            await fallback.check();
            await dialog.getByRole('button', { name: 'Save settings', exact: true }).click();
            expect(await page.evaluate(() => localStorage.getItem('twitchAdSolutions_pageRefreshFallback'))).toBe('true');
            await dialog.getByRole('button', { name: 'Reset these settings', exact: true }).click();
            await expect(fallback).not.toBeChecked();
            expect(await page.evaluate(() => localStorage.getItem('twitchAdSolutions_pageRefreshFallback'))).toBeNull();
        });

        test('synthetic resilience: ' + script.file + ' reloads the document only after opt-in recovery exhaustion', async ({ page, context }) => {
            await bootRecovery(page, context, script.file);
            let navigations = 0;
            page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations++; });
            await page.evaluate(() => {
                localStorage.setItem('twitchAdSolutions_pageRefreshFallback', 'true');
                window.__recoveryFixture.retainVideo = true;
                window.__recoveryFixture.current.video.playbackRate = 0;
                Object.defineProperty(window.__recoveryFixture.current.video, 'readyState', { configurable: true, value: 1 });
                Object.defineProperty(window.__recoveryFixture.current.video, 'buffered', { configurable: true, value: { length: 0 } });
            });
            await page.evaluate(() => window.__recoveryFixture.reload('early'));
            await page.clock.runFor(13000);
            expect(await page.evaluate(() => window.__recoveryFixture.reloads.length)).toBe(2);
            expect(navigations).toBe(0);
            await page.clock.runFor(2500);
            await expect.poll(() => navigations).toBe(1);
            await expect.poll(() => page.evaluate(() => Number(sessionStorage.getItem('twitchAdSolutions_lastPageRefreshAt')))).toBeGreaterThan(0);
            await expect(page.getByRole('button', { name: 'Ad blocker settings', exact: true })).toBeVisible();
        });

        test('synthetic resilience: ' + script.file + ' resets a native paused video with a playing wrapper', async ({ page, context }) => {
            await bootRecovery(page, context, script.file);
            await page.clock.runFor(600);
            const baseline = await page.evaluate(() => window.__recoveryFixture.current.video.currentTime);
            await expect.poll(() => page.evaluate(() => window.__recoveryFixture.current.video.currentTime)).toBeGreaterThan(baseline + 0.2);
            await page.clock.runFor(600);
            await page.evaluate(async () => {
                const fixture = window.__recoveryFixture;
                await fixture.adBreak();
                fixture.current.video.playbackRate = 0;
                Object.defineProperty(fixture.current.video, 'paused', { configurable: true, value: true });
                fixture.current.isPaused = () => false;
                fixture.current.core.paused = true;
            });
            await page.clock.runFor(600);
            await page.evaluate(() => window.__recoveryFixture.endAdBreak());
            expect(await page.evaluate(() => window.twitchAdSolutionsTools.diagnostics().playback)).toMatchObject({
                paused: true, playerPaused: false, corePaused: true, userPauseIntent: false, recoveryActive: false
            });
            await page.clock.runFor(19200);
            expect(await page.evaluate(() => window.__recoveryFixture.reloads)).toEqual([
                { isNewMediaPlayerInstance: true, refreshAccessToken: true }
            ]);
            await expect.poll(() => page.evaluate(() => window.__recoveryFixture.current.video.readyState)).toBeGreaterThanOrEqual(2);
            await page.evaluate(() => { window.__recoveryFixture.current.video.currentTime = 17; });
            await page.clock.runFor(150);
            await expect.poll(() => page.evaluate(() => window.__recoveryFixture.current.video.currentTime)).toBeGreaterThan(17.2);
            await page.clock.runFor(300);
            expect(await page.evaluate(() => window.twitchAdSolutionsTools.diagnostics().events.some(event => event.event === 'recovery-finished' && event.success))).toBe(true);
        });

        test('synthetic resilience: ' + script.file + ' recovers a depleted native video after an ad ends', async ({ page, context }) => {
            await bootRecovery(page, context, script.file);
            await page.clock.runFor(600);
            const baseline = await page.evaluate(() => window.__recoveryFixture.current.video.currentTime);
            await expect.poll(() => page.evaluate(() => window.__recoveryFixture.current.video.currentTime)).toBeGreaterThan(baseline + 0.2);
            await page.clock.runFor(600);
            await page.evaluate(async () => {
                const fixture = window.__recoveryFixture;
                await fixture.adBreak();
                fixture.current.video.playbackRate = 0;
                Object.defineProperty(fixture.current.video, 'readyState', { configurable: true, value: 1 });
                Object.defineProperty(fixture.current.video, 'buffered', { configurable: true, value: { length: 0 } });
            });
            await page.clock.runFor(600);
            await page.evaluate(() => window.__recoveryFixture.endAdBreak());
            expect(await page.evaluate(() => window.twitchAdSolutionsTools.diagnostics().playback)).toMatchObject({
                readyState: 1, inAdBreak: false, recoveryActive: false, buffered: []
            });
            await page.clock.runFor(12400);
            expect(await page.evaluate(() => window.__recoveryFixture.reloads.length)).toBe(0);
            await page.clock.runFor(1800);
            expect(await page.evaluate(() => window.__recoveryFixture.reloads)).toEqual([
                { isNewMediaPlayerInstance: true, refreshAccessToken: true }
            ]);
            await expect.poll(() => page.evaluate(() => window.__recoveryFixture.current.video.readyState)).toBeGreaterThanOrEqual(2);
            await page.evaluate(() => { window.__recoveryFixture.current.video.currentTime = 17; });
            await page.clock.runFor(150);
            await expect.poll(() => page.evaluate(() => window.__recoveryFixture.current.video.currentTime)).toBeGreaterThan(17.2);
            await page.clock.runFor(300);
            const events = await page.evaluate(() => window.twitchAdSolutionsTools.diagnostics().events);
            expect(events.some(event => event.event === 'reload-start' && event.hardReload)).toBe(true);
            expect(events.some(event => event.event === 'recovery-finished' && event.success)).toBe(true);
            expect(states.get(page).logs.some(message => message.includes('Post-ad playhead frozen'))).toBe(true);
        });

        test('synthetic resilience: ' + script.file + ' runs shared recovery helpers inside the injected worker', async ({ page, context }) => {
            await boot(page, context, script.file);
            const result = await page.evaluate(async () => {
                const source = `
                    (async () => {
                        try {
                            const results = [];
                            BackupPlayerTypes = [];
                            PreferLowQualityBackup = false;
                            for (const sticky of [false, true]) {
                                AdSegmentCache.clear();
                                const messages = [];
                                postStreamMessage = (stream, message) => messages.push(message);
                                const stream = createStreamInfo('fixture-channel', '', '');
                                const url = 'https://www.twitch.tv/fixtures/recovery.m3u8';
                                stream.IsShowingAd = true;
                                stream.CsaiOnlyThisBreak = sticky;
                                stream.HasConfirmedAdAttrs = true;
                                stream.Urls[url] = { Resolution: '1920x1080', FrameRate: 60, Codecs: 'avc1.4d4028' };
                                StreamInfos['fixture-channel'] = stream;
                                StreamInfosByUrl[url] = stream;
                                ActiveStreamInfo = stream;
                                const ads = '#EXTM3U\\n#EXT-X-DATERANGE:CLASS="twitch-stitched-ad",TYPE="MIDROLL"\\n#EXT-X-MEDIA-SEQUENCE:100\\n#EXTINF:2.000,ad\\nhttps://www.twitch.tv/fixtures/stitched-ad.ts\\n';
                                for (let poll = 0; poll < 5; poll++) await processM3U8(url, ads, null);
                                const early = messages.filter(message => message.key === 'ReloadPlayer').length;
                                for (let sequence = 101; sequence <= 103; sequence++) {
                                    await processM3U8(url, '#EXTM3U\\n#EXT-X-MEDIA-SEQUENCE:' + sequence + '\\n#EXTINF:2.000,live\\nhttps://www.twitch.tv/fixtures/live-' + sequence + '.ts\\n', null);
                                }
                                results.push({ sticky, early, total: messages.filter(message => message.key === 'ReloadPlayer').length,
                                    closed: !stream.IsShowingAd, pending: stream.PendingAdEndAt, signature: stream.LastCleanSignature });
                            }
                            self.postMessage({ fixture: true, results });
                        } catch (error) { self.postMessage({ fixture: true, error: error.message }); }
                    })();
                `;
                const worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
                try {
                    return await new Promise((resolve, reject) => {
                        worker.addEventListener('message', event => { if (event.data.fixture) resolve(event.data); });
                        worker.addEventListener('error', event => reject(new Error(event.message)), { once: true });
                    });
                } finally { worker.terminate(); }
            });
            expect(result).toEqual({ fixture: true, results: [false, true].map(sticky => ({
                sticky, early: 2, total: 3, closed: true, pending: 0, signature: null
            })) });
        });

        test('synthetic resilience: ' + script.file + ' honors a worker hard reset near the native live edge', async ({ page, context }) => {
            await bootRecovery(page, context, script.file);
            await page.evaluate(() => { window.__recoveryFixture.current.video.currentTime = 17; });
            await expect.poll(() => page.evaluate(() => {
                const video = window.__recoveryFixture.current.video;
                return video.readyState >= 3 && !video.paused && !video.seeking && video.seekable.length > 0
                    && video.seekable.end(video.seekable.length - 1) - video.currentTime <= 7;
            })).toBe(true);
            await page.evaluate(() => window.reloadTwitchPlayer());
            expect(await page.evaluate(() => window.__recoveryFixture.reloads.length)).toBe(0);
            await page.evaluate(() => window.__recoveryFixture.reload('early'));
            expect(await page.evaluate(() => ({
                reloads: window.__recoveryFixture.reloads,
                originalConnected: window.__recoveryFixture.players[0].video.isConnected
            }))).toEqual({ reloads: [{ isNewMediaPlayerInstance: true, refreshAccessToken: true }], originalConnected: false });
        });

        test('synthetic resilience: ' + script.file + ' recovers a frozen native ad backup without stripped segments', async ({ page, context }) => {
            await bootRecovery(page, context, script.file);
            await page.clock.runFor(600);
            const baseline = await page.evaluate(() => window.__recoveryFixture.current.video.currentTime);
            await expect.poll(() => page.evaluate(() => window.__recoveryFixture.current.video.currentTime)).toBeGreaterThan(baseline + 0.2);
            await page.clock.runFor(600);
            await page.evaluate(async () => {
                const fixture = window.__recoveryFixture;
                await fixture.adBreak();
                fixture.current.video.playbackRate = 0;
            });
            expect(await page.evaluate(() => ({
                paused: window.__recoveryFixture.current.video.paused,
                ranges: window.__recoveryFixture.current.video.buffered.length
            }))).toEqual({ paused: false, ranges: 1 });
            await page.clock.runFor(17400);
            expect(await page.evaluate(() => window.__recoveryFixture.reloads.length)).toBe(0);
            await page.clock.runFor(1800);
            expect(await page.evaluate(() => window.__recoveryFixture.reloads)).toEqual([
                { isNewMediaPlayerInstance: true, refreshAccessToken: true }
            ]);
            await expect.poll(() => page.evaluate(() => window.__recoveryFixture.current.video.readyState)).toBeGreaterThanOrEqual(2);
            await page.evaluate(() => { window.__recoveryFixture.current.video.currentTime = 17; });
            await expect.poll(() => page.evaluate(() => window.__recoveryFixture.current.video.readyState)).toBeGreaterThanOrEqual(2);
            await page.clock.runFor(150);
            await expect.poll(() => page.evaluate(() => window.__recoveryFixture.current.video.currentTime)).toBeGreaterThan(17.2);
            expect(states.get(page).logs.some(message => message.includes('Ad backup playhead frozen'))).toBe(true);
        });

        for (const navigateDuringRecovery of [false, true]) {
            test('synthetic resilience: ' + script.file + ' recovers the Drops mini-player, navigation during recovery=' + navigateDuringRecovery, async ({ page, context }) => {
                await bootRecovery(page, context, script.file);
                if (!navigateDuringRecovery) await page.evaluate(() => history.pushState({}, '', '/drops/inventory'));
                await page.evaluate(() => window.__recoveryFixture.reload('early'));
                expect(await page.evaluate(() => window.__recoveryFixture.reloads.length)).toBe(1);
                if (navigateDuringRecovery) await page.evaluate(() => history.pushState({}, '', '/drops/inventory'));
                await expect.poll(() => page.evaluate(() => window.__recoveryFixture.current.video.readyState)).toBeGreaterThanOrEqual(2);
                await page.evaluate(() => { window.__recoveryFixture.current.video.currentTime = 17; });
                await expect.poll(() => page.evaluate(() => window.__recoveryFixture.current.video.readyState)).toBeGreaterThanOrEqual(2);
                await page.clock.runFor(150);
                await expect.poll(() => page.evaluate(() => window.__recoveryFixture.current.video.currentTime)).toBeGreaterThan(17.2);
                await page.clock.runFor(3000);
                expect(await page.evaluate(() => ({
                    muted: window.__recoveryFixture.current.video.muted,
                    paused: window.__recoveryFixture.current.video.paused,
                    plays: window.__recoveryFixture.current.plays,
                    reloads: window.__recoveryFixture.reloads.length,
                    adMuted: document.getElementById('fixture-ad').muted
                }))).toEqual({ muted: false, paused: false, plays: 1, reloads: 1, adMuted: true });
            });
        }

        for (const userMute of [false, true]) {
            test('synthetic resilience: ' + script.file + ' rolls back failed native-video recovery, user mute=' + userMute, async ({ page, context }) => {
                await bootRecovery(page, context, script.file);
                await page.evaluate(async userMute => {
                    const fixture = window.__recoveryFixture;
                    fixture.fail = true;
                    fixture.userMute = userMute;
                    await fixture.reload('early');
                }, userMute);
                await page.clock.runFor(5500);
                expect(await page.evaluate(() => ({
                    muted: window.__recoveryFixture.current.video.muted,
                    paused: window.__recoveryFixture.current.video.paused,
                    reloads: window.__recoveryFixture.reloads.length,
                    adMuted: document.getElementById('fixture-ad').muted
                }))).toEqual({ muted: userMute, paused: false, reloads: 1, adMuted: true });
            });
        }

        test('synthetic resilience: ' + script.file + ' resumes and unmutes the replacement native video', async ({ page, context }) => {
            await bootRecovery(page, context, script.file);
            await page.evaluate(() => window.__recoveryFixture.reload('early'));
            await expect.poll(() => page.evaluate(() => window.__recoveryFixture.current.video.readyState)).toBeGreaterThanOrEqual(2);
            // Start near the finite fixture's edge so live catch-up does not seek to its end.
            await page.evaluate(() => { window.__recoveryFixture.current.video.currentTime = 17; });
            await expect.poll(() => page.evaluate(() => window.__recoveryFixture.current.video.readyState)).toBeGreaterThanOrEqual(2);
            await page.clock.runFor(150);
            await expect.poll(() => page.evaluate(() => window.__recoveryFixture.current.video.currentTime)).toBeGreaterThan(17.2);
            await page.clock.runFor(3000);
            expect(await page.evaluate(() => {
                const fixture = window.__recoveryFixture;
                return { native: fixture.current.video instanceof HTMLVideoElement,
                    muted: fixture.current.video.muted, paused: fixture.current.video.paused,
                    originalPlays: fixture.players[0].plays, replacementPlays: fixture.current.plays,
                    originalConnected: fixture.players[0].video.isConnected,
                    reloads: fixture.reloads.length, adMuted: document.getElementById('fixture-ad').muted };
            })).toEqual({ native: true, muted: false, paused: false, originalPlays: 0, replacementPlays: 1, originalConnected: false, reloads: 1, adMuted: true });
        });

        test('synthetic resilience: ' + script.file + ' upgrades overlapping soft and hard browser recovery', async ({ page, context }) => {
            await bootRecovery(page, context, script.file);
            await page.evaluate(async () => {
                window.reloadTwitchPlayer();
                await window.__recoveryFixture.reload('early');
            });
            await page.clock.runFor(150);
            expect(await page.evaluate(() => window.__recoveryFixture.reloads)).toEqual([
                { isNewMediaPlayerInstance: false, refreshAccessToken: false },
                { isNewMediaPlayerInstance: true, refreshAccessToken: true }
            ]);
            await page.evaluate(() => window.__recoveryFixture.reload('early'));
            await page.clock.runFor(13000);
            expect(await page.evaluate(() => window.__recoveryFixture.reloads.length)).toBe(2);
        });

        for (const reason of ['pause', 'pip']) {
            test('synthetic resilience: ' + script.file + ' cancels native-video recovery for ' + reason, async ({ page, context }) => {
                await bootRecovery(page, context, script.file);
                await page.clock.runFor(600);
                await page.evaluate(async () => {
                    window.__recoveryFixture.retainVideo = true;
                    await window.__recoveryFixture.reload('early');
                });
                if (reason === 'pause') await page.clock.runFor(150);
                await page.evaluate(reason => {
                    const fixture = window.__recoveryFixture;
                    if (reason === 'pause') fixture.current.pause();
                    else fixture.pip = fixture.current.video;
                }, reason);
                await page.clock.runFor(6000);
                expect(await page.evaluate(() => ({ muted: window.__recoveryFixture.current.video.muted,
                    paused: window.__recoveryFixture.current.video.paused, reloads: window.__recoveryFixture.reloads.length })))
                    .toEqual({ muted: false, paused: reason === 'pause', reloads: 1 });
            });
        }

        test('synthetic resilience: ' + script.file + ' handles optional GQL headers and v2 worker playlist failures', async ({ page, context }) => {
            await boot(page, context, script.file);
            const result = await page.evaluate(async () => {
                for (const input of ['https://gql.twitch.tv/gql', new URL('https://gql.twitch.tv/gql'), new Request('https://gql.twitch.tv/gql')]) {
                    await fetch(input);
                }
                const source = `
                    (async () => {
                        try {
                            const base = 'https://www.twitch.tv';
                            await fetch(base + '/api/v2/channel/hls/fixture-channel.m3u8?token=fixture');
                            const stream = StreamInfos['fixture-channel'];
                            processStreamPlaylist = async (url, text) => text + '#fixture-processed';
                            const media = await (await fetch(new Request(stream.ResolutionList[0].Url))).text();
                            const query = await (await fetch(new URL(base + '/fixtures/clean.m3u8?token=fixture'))).text();
                            const readText = Response.prototype.text;
                            let rejected = false;
                            Response.prototype.text = async function() { throw new Error('fixture body rejected'); };
                            try { await fetch(base + '/fixtures/clean.m3u8?failure=fixture'); }
                            catch (error) { rejected = error.message === 'fixture body rejected'; }
                            finally { Response.prototype.text = readText; }
                            self.postMessage({ fixture: true, media, query, rejected, resolutions: stream.ResolutionList.length });
                        } catch (error) { self.postMessage({ fixture: true, error: error.message }); }
                    })();
                `;
                const worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
                try {
                    return await new Promise((resolve, reject) => {
                        worker.addEventListener('message', event => { if (event.data.fixture) resolve(event.data); });
                        worker.addEventListener('error', event => reject(new Error(event.message)), { once: true });
                    });
                } finally { worker.terminate(); }
            });
            expect(result.error).toBeUndefined();
            expect(result.resolutions).toBe(2);
            expect(result.media).toContain('#fixture-processed');
            expect(result.query).toContain('#fixture-processed');
            expect(result.rejected).toBe(true);
        });
    }

    test('synthetic resilience: ' + script.file + ' boots once and preserves ordinary fetch and reused XHR', async ({ page, context }) => {
        await boot(page, context, script.file);
        const result = await page.evaluate(async source => {
            const version = window.twitchAdSolutionsVersion ?? window.twitchBraveFixVersion;
            const fetchBefore = window.fetch;
            const workerBefore = window.Worker;
            (0, eval)(source);
            const responses = [];
            for (const input of ['/fixtures/passthrough', new URL('/fixtures/passthrough', location.href), new Request(new URL('/fixtures/passthrough', location.href))]) {
                const response = await fetch(input);
                responses.push({ status: response.status, header: response.headers.get('x-fixture'), body: await response.json() });
            }
            const xhr = new XMLHttpRequest();
            const xhrBodies = [];
            for (const suffix of ['one', 'two']) {
                xhrBodies.push(await new Promise((resolve, reject) => {
                    xhr.open('GET', '/fixtures/passthrough-' + suffix);
                    xhr.onload = () => resolve({ status: xhr.status, body: JSON.parse(xhr.responseText) });
                    xhr.onerror = reject;
                    xhr.send();
                }));
            }
            return { version, sameFetch: fetchBefore === window.fetch, sameWorker: workerBefore === window.Worker, responses, xhrBodies };
        }, readScript(script.file));
        expect(result.version).toBeGreaterThan(0);
        expect(result.sameFetch).toBe(true);
        expect(result.sameWorker).toBe(true);
        expect(result.responses).toEqual(Array(3).fill({ status: 207, header: 'preserved', body: { fixture: 'passthrough' } }));
        expect(result.xhrBodies).toEqual(Array(2).fill({ status: 207, body: { fixture: 'passthrough' } }));
    });

    if (!script.file.startsWith('strip/')) {
        test('synthetic resilience: ' + script.file + ' leaves Twitch clip pages untouched', async ({ page, context }) => {
            await boot(page, context, script.file, 'https://www.twitch.tv/fixture-channel/clip/fixture');
            expect(await page.evaluate(() => ({
                version: window.twitchAdSolutionsVersion ?? window.twitchBraveFixVersion ?? null,
                fetchUnchanged: fetch === window.__nativeFetch,
                workerUnchanged: Worker === window.__nativeWorker
            }))).toEqual({ version: null, fetchUnchanged: true, workerUnchanged: true });
        });
    }

    if (script.file.includes('ublock-origin')) {
        test('synthetic resilience: ' + script.file + ' ignores non-Twitch origins', async ({ page, context }) => {
            await boot(page, context, script.file, 'https://example.com/fixture');
            expect(await page.evaluate(() => ({
                version: window.twitchAdSolutionsVersion ?? window.twitchBraveFixVersion ?? null,
                fetchUnchanged: fetch === window.__nativeFetch,
                workerUnchanged: Worker === window.__nativeWorker
            }))).toEqual({ version: null, fetchUnchanged: true, workerUnchanged: true });
        });
    }

    if (script.worker) {
        test('synthetic resilience: ' + script.file + ' runs its injected worker and replaces cached ad media', async ({ page, context }) => {
            const state = await boot(page, context, script.file);
            const result = await page.evaluate(async () => {
                const source = `
                    self.addEventListener('message', async event => {
                        if (!event.data.fixture) return;
                        try {
                            if (event.data.cache) AdSegmentCache.set(event.data.url, Date.now());
                            const response = await fetch(event.data.url);
                            const body = await response.arrayBuffer();
                            self.postMessage({ fixture: true, status: response.status, type: response.headers.get('content-type'), size: body.byteLength, signature: Array.from(new Uint8Array(body).slice(4, 8)), text: event.data.cache ? null : new TextDecoder().decode(body) });
                        } catch (error) { self.postMessage({ fixture: true, error: error.message }); }
                    });
                    self.postMessage({ fixture: true, ready: true });
                `;
                const worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
                const next = () => new Promise((resolve, reject) => {
                    const onMessage = event => {
                        if (!event.data.fixture) return;
                        worker.removeEventListener('message', onMessage);
                        resolve(event.data);
                    };
                    worker.addEventListener('message', onMessage);
                    worker.addEventListener('error', event => reject(new Error(event.message)), { once: true });
                });
                try {
                    const ready = await next();
                    const clean = next();
                    worker.postMessage({ fixture: true, url: location.origin + '/fixtures/clean.m3u8' });
                    const cleanResult = await clean;
                    const blocked = next();
                    worker.postMessage({ fixture: true, cache: true, url: location.origin + '/fixtures/blocked-ad.ts' });
                    return { ready, clean: cleanResult, blocked: await blocked };
                } finally { worker.terminate(); }
            });
            expect(result.ready.ready).toBe(true);
            expect(result.clean.error).toBeUndefined();
            expect(result.clean.status).toBe(200);
            expect(result.clean.text).toBe(cleanPlaylist);
            expect(result.blocked.error).toBeUndefined();
            expect(result.blocked.status).toBe(200);
            expect(result.blocked.type).toBe('video/mp4');
            expect(result.blocked.size).toBeGreaterThan(200);
            expect(result.blocked.signature).toEqual([102, 116, 121, 112]);
            // Legacy strip downloads the original before returning its MP4 placeholder.
            expect(state.requests.some(url => url.endsWith('/fixtures/blocked-ad.ts'))).toBe(script.file.startsWith('strip/'));
        });
    }
}

for (const file of scripts.filter(script => script.file.includes('brave-fix')).map(script => script.file)) {
    test('synthetic resilience: ' + file + ' masks Brave fingerprint properties', async ({ page, context }) => {
        await boot(page, context, file);
        expect(await page.evaluate(async () => ({
            braveHidden: navigator.brave === undefined,
            brands: navigator.userAgentData.brands,
            entropyBrands: (await navigator.userAgentData.getHighEntropyValues(['brands'])).brands
        }))).toEqual({ braveHidden: true, brands: [{ brand: 'Google Chrome', version: '156' }], entropyBrands: [{ brand: 'Google Chrome', version: '156' }] });
    });
}

for (const file of ['vaft/vaft.user.js', 'vaft/vaft-ublock-origin.js',
    'video-swap-new/video-swap-new.user.js', 'video-swap-new/video-swap-new-ublock-origin.js']) {
    test('synthetic resilience: ' + file + ' preserves recovery numbering and blocks relative ad media inside its injected worker', async ({ page, context }) => {
        const state = await boot(page, context, file);
        await context.route('https://www.twitch.tv/fixtures/relative.m3u8', route => route.fulfill({
            contentType: 'application/vnd.apple.mpegurl',
            body: '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:300\n#EXT-X-DATERANGE:CLASS="twitch-stitched-ad",TYPE="MIDROLL"\n#EXTINF:2,ad\nblocked-ad.ts\n'
        }));
        const result = await page.evaluate(async () => {
            const source = String.raw`
                (async () => {
                    try {
                        if (typeof BackupPlayerTypes !== 'undefined') BackupPlayerTypes = [];
                        if (typeof PreferLowQualityBackup !== 'undefined') PreferLowQualityBackup = false;
                        if (typeof OPT_BACKUP_PLAYER_TYPES !== 'undefined') OPT_BACKUP_PLAYER_TYPES = [];
                        const cache = createStreamInfo('fixture-channel', '', '');
                        stripAdSegments('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:100\n#EXTINF:2,ad\nhttps://www.twitch.tv/fixtures/ad100.ts\n#EXTINF:2,live\nhttps://www.twitch.tv/fixtures/live101.ts\n#EXTINF:2,live\nhttps://www.twitch.tv/fixtures/live102.ts\n', false, cache);
                        const recovered = stripAdSegments('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:200\n#EXTINF:2,ad\nhttps://www.twitch.tv/fixtures/ad200.ts\n#EXTINF:2,ad\nhttps://www.twitch.tv/fixtures/ad201.ts\n', false, cache);
                        const firstSequence = Number(recovered.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/)[1]);
                        const segments = recovered.split('\n').filter(line => line && !line.startsWith('#'))
                            .map((url, i) => ({ url, sequence: firstSequence + i }));
                        const url = 'https://www.twitch.tv/fixtures/relative.m3u8';
                        const stream = createStreamInfo('fixture-channel', '', '');
                        const resolution = { Resolution: '1920x1080', FrameRate: 60, Codecs: 'avc1.4d4028' };
                        if (stream.Urls instanceof Map) stream.Urls.set(url, resolution);
                        else stream.Urls[url] = resolution;
                        StreamInfos['fixture-channel'] = stream;
                        StreamInfosByUrl[url] = stream;
                        if (typeof ActiveStreamInfo !== 'undefined') ActiveStreamInfo = stream;
                        const media = await (await fetch(url)).text();
                        const uri = media.split('\n').find(line => line && !line.startsWith('#'));
                        const response = await fetch(new URL(uri, url).href);
                        const bytes = new Uint8Array(await response.arrayBuffer());
                        self.postMessage({ fixture: true, segments, media, signature: Array.from(bytes.slice(4, 8)) });
                    } catch (error) { self.postMessage({ fixture: true, error: error.stack }); }
                })();
            `;
            const worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
            try {
                return await new Promise((resolve, reject) => {
                    worker.addEventListener('message', event => { if (event.data.fixture) resolve(event.data); });
                    worker.addEventListener('error', event => reject(new Error(event.message)), { once: true });
                });
            } finally { worker.terminate(); }
        });
        expect(result.error).toBeUndefined();
        expect(result.segments).toEqual([
            { url: 'https://www.twitch.tv/fixtures/live101.ts', sequence: 101 },
            { url: 'https://www.twitch.tv/fixtures/live102.ts', sequence: 102 }
        ]);
        expect(result.signature).toEqual([102, 116, 121, 112]);
        expect(state.requests.some(url => url.endsWith('/blocked-ad.ts'))).toBe(false);
    });
}

for (const url of ['https://gql.twitch.tv/gql', 'https://gql.twitch.tv/integrity', 'https://passport.twitch.tv/integrity']) {
    for (const requestInput of [false, true]) {
        test('synthetic resilience: Brave userscript retries a rejected ' + (requestInput ? 'Request' : 'URL') + ' at ' + url + ' through the manager transport', async ({ page, context }) => {
            await boot(page, context, 'vaft/twitch-brave-fix.user.js');
            await context.route(url, route => route.fulfill({ contentType: 'application/json', body: '{"errors":[{"message":"failed integrity check"}]}' }));
            const result = await page.evaluate(async ({ requestInput, url }) => {
                const init = { method: 'POST', body: '{"operationName":"Fixture"}' };
                const response = await (requestInput ? fetch(new Request(url, init)) : fetch(url, init));
                return { body: await response.json(), calls: window.__gmCalls };
            }, { requestInput, url });
            expect(result.body).toEqual({ data: { fixture: true } });
            expect(result.calls).toHaveLength(1);
            expect(result.calls[0]).toMatchObject({ url, method: 'POST', data: '{"operationName":"Fixture"}' });
            expect(Object.keys(result.calls[0].headers).map(name => name.toLowerCase())).not.toContain('host');
            expect(result.calls[0].headers['Sec-Ch-Ua']).toContain('Google Chrome');
            expect(result.calls[0].headers['Sec-Ch-Ua']).not.toContain('Brave');
        });
    }
}

test('synthetic resilience: Brave userscript preserves the original response when manager transport fails', async ({ page, context }) => {
    await boot(page, context, 'vaft/twitch-brave-fix.user.js');
    expect(await page.evaluate(async () => {
        window.__gmFail = true;
        return (await fetch('https://gql.twitch.tv/gql', { method: 'POST', body: '{}' })).json();
    })).toEqual({ errors: [{ message: 'failed integrity check' }] });
});

test('synthetic resilience: Brave preserves byte-array bodies through the retry transport', async ({ page, context }) => {
    await boot(page, context, 'vaft/twitch-brave-fix.user.js');
    const result = await page.evaluate(async () => {
        await fetch('https://gql.twitch.tv/gql', { method: 'POST', body: new Uint8Array([0, 128, 255, 65]) });
        return Array.from(new Uint8Array(window.__gmCalls[0].data));
    });
    expect(result).toEqual([0, 128, 255, 65]);
});

for (const body of [
    [{ data: { fixtureMutation: { id: 'written-once' } } }, { errors: [{ message: 'failed integrity check' }] }],
    { data: { fixtureMutation: { id: 'written-once' } }, errors: [{ message: 'failed integrity check' }] },
    { errors: [{ message: 'permission denied' }] }
]) {
    test('synthetic resilience: Brave preserves successful operations and ordinary GraphQL errors: ' + JSON.stringify(body), async ({ page, context }) => {
        await boot(page, context, 'vaft/twitch-brave-fix.user.js');
        let nativeCalls = 0;
        await context.route('https://gql.twitch.tv/gql', async route => {
            nativeCalls++;
            await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
        });
        const result = await page.evaluate(async () => ({
            body: await (await fetch('https://gql.twitch.tv/gql', { method: 'POST', body: '[{"operationName":"FixtureMutation"},{"operationName":"FixtureQuery"}]' })).json(),
            managerCalls: window.__gmCalls.length
        }));
        expect(result).toEqual({ body, managerCalls: 0 });
        expect(nativeCalls).toBe(1);
    });
}

for (const userscriptFirst of [false, true]) {
    test('synthetic resilience: Brave retry survives both helper load orders, userscript first=' + userscriptFirst, async ({ page, context }) => {
        const files = ['vaft/twitch-brave-fix.user.js', 'vaft/twitch-brave-fix-ublock-origin.js'];
        if (!userscriptFirst) files.reverse();
        await boot(page, context, files[0]);
        await page.addScriptTag({ content: readScript(files[1]) });
        await page.addScriptTag({ content: readScript(files[0]) });
        expect(await page.evaluate(async () => ({
            body: await (await fetch('https://gql.twitch.tv/gql')).json(), calls: window.__gmCalls.length
        }))).toEqual({ body: { data: { fixture: true } }, calls: 1 });
    });
}

test('synthetic resilience: Brave userscript aborts a pending manager request', async ({ page, context }) => {
    await boot(page, context, 'vaft/twitch-brave-fix.user.js');
    await page.evaluate(() => {
        window.__gmPending = true;
        window.__retryController = new AbortController();
        window.__retryResult = fetch('https://gql.twitch.tv/gql', { signal: window.__retryController.signal })
            .then(() => 'resolved', error => error.name);
    });
    await expect.poll(() => page.evaluate(() => window.__gmCalls.length)).toBe(1);
    await page.evaluate(() => window.__retryController.abort());
    expect(await page.evaluate(() => window.__retryResult)).toBe('AbortError');
    expect(await page.evaluate(() => window.__gmAborts)).toBe(1);
});

test('synthetic resilience: Brave userscript bounds a silent manager request', async ({ page, context }) => {
    await page.clock.install();
    await boot(page, context, 'vaft/twitch-brave-fix.user.js');
    await page.evaluate(() => {
        window.__gmPending = true;
        window.__retryResult = fetch('https://gql.twitch.tv/gql').then(response => response.json());
    });
    await expect.poll(() => page.evaluate(() => window.__gmCalls.length)).toBe(1);
    await page.clock.fastForward(15000);
    expect(await page.evaluate(() => window.__retryResult)).toEqual({ errors: [{ message: 'failed integrity check' }] });
    expect(await page.evaluate(() => window.__gmAborts)).toBe(1);
});

for (const file of scripts.filter(script => /^(vaft\/vaft|video-swap-new\/)/.test(script.file)).map(script => script.file)) {
    test('synthetic resilience: settings button moves, hides and reopens with the keyboard in ' + file, async ({ page, context }) => {
        await boot(page, context, file);
        const trigger = page.getByRole('button', { name: 'Ad blocker settings', exact: true });
        const dialog = page.getByRole('dialog', { name: 'Ad blocker settings' });
        await trigger.click();
        await dialog.getByLabel('Settings button position').selectOption('top-left');
        await dialog.getByRole('button', { name: 'Save settings' }).click();
        await page.keyboard.press('Escape');
        await expect(trigger).toBeFocused();
        await expect(page.locator('#tas-controls')).toHaveCSS('left', '12px');
        await expect(page.locator('#tas-controls')).toHaveCSS('top', '12px');
        await page.reload();
        await expect(page.locator('#tas-controls')).toHaveCSS('left', '12px');
        await expect(page.locator('#tas-controls')).toHaveCSS('top', '12px');
        await trigger.click();
        await dialog.getByLabel('Hide settings button', { exact: true }).check();
        await dialog.getByRole('button', { name: 'Save settings' }).click();
        await page.keyboard.press('Escape');
        await expect(trigger).toBeHidden();
        await page.reload();
        await expect(trigger).toBeHidden();
        await page.keyboard.press('Alt+Shift+A');
        await expect(dialog).toBeVisible();
        await dialog.getByRole('button', { name: 'Reset these settings' }).click();
        await page.keyboard.press('Escape');
        await expect(trigger).toBeVisible();
        await expect(trigger).toBeFocused();
        await expect(page.locator('#tas-controls')).toHaveCSS('right', '12px');
        await expect(page.locator('#tas-controls')).toHaveCSS('bottom', '12px');
    });

    test('synthetic resilience: settings validate, reset, export and restore keyboard focus in ' + file, async ({ page, context }) => {
        await boot(page, context, file);
        const trigger = page.getByRole('button', { name: 'Ad blocker settings', exact: true });
        await trigger.click();
        const dialog = page.getByRole('dialog', { name: 'Ad blocker settings' });
        await expect(dialog).toBeVisible();
        const cooldown = dialog.getByLabel('Reload cooldown in seconds');
        await cooldown.fill('-1');
        await dialog.getByRole('button', { name: 'Save settings' }).click();
        expect(await page.evaluate(() => localStorage.getItem('twitchAdSolutions_reloadCooldownSeconds'))).toBeNull();
        await expect(cooldown).toBeFocused();
        await cooldown.fill('45');
        await dialog.getByLabel('Show backup and recovery status').check();
        await dialog.getByRole('button', { name: 'Save settings' }).click();
        expect(await page.evaluate(() => localStorage.getItem('twitchAdSolutions_reloadCooldownSeconds'))).toBe('45');
        await expect(dialog.getByRole('status')).toContainText('Settings saved');
        await page.keyboard.press('Escape');
        await expect(dialog).not.toBeVisible();
        await expect(trigger).toBeFocused();
        await expect(page.locator('#tas-controls').locator('#details')).toBeVisible();
        await page.evaluate(() => {
            const source = `self.postMessage({key:'TASDiagnostic',event:'backup-selected',playerType:'autoplay',quality:'640x360',durationMs:120,authorization:'OAuth private',url:'https://private.invalid/token'});`;
            window.__diagnosticWorker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
        });
        await expect(page.locator('#tas-controls').locator('#details')).toContainText('640x360');
        await trigger.click();
        const pendingDownload = page.waitForEvent('download');
        await dialog.getByRole('button', { name: 'Export diagnostics' }).click();
        const download = await pendingDownload;
        expect(download.suggestedFilename()).toBe('twitch-ad-solutions-diagnostics.json');
        const report = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
        expect(report.current).toMatchObject({ backup: 'autoplay', quality: '640x360' });
        expect(JSON.stringify(report)).not.toContain('private');
        expect(report.events.some(event => event.event === 'backup-selected' && event.durationMs === 120)).toBe(true);
        await dialog.getByRole('button', { name: 'Reset these settings' }).click();
        expect(await page.evaluate(() => localStorage.getItem('twitchAdSolutions_reloadCooldownSeconds'))).toBeNull();
        await expect(cooldown).toHaveValue('30');
        await expect(page.locator('#tas-controls').locator('#details')).toBeHidden();
        await dialog.getByRole('button', { name: 'Close', exact: true }).click();
        await expect(trigger).toBeFocused();
        await page.evaluate(() => window.__diagnosticWorker.terminate());
    });
}
