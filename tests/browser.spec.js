const { test, expect } = require('@playwright/test');
const { scripts, readScript } = require('./scripts');

const states = new WeakMap();
const cleanPlaylist = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.000,live\nhttps://www.twitch.tv/fixtures/live.ts\n';

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
            await route.fulfill({ contentType: 'application/json', body: '{"errors":[{"message":"fixture fingerprint rejection"}]}' });
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
        window.GM_xmlHttpRequest = options => {
            window.__gmCalls.push({ url: options.url, method: options.method, data: options.data, headers: options.headers });
            queueMicrotask(() => {
                if (window.__gmFail) options.onerror({ error: 'fixture transport failure' });
                else options.onload({ status: 200, responseText: '{"data":{"fixture":true}}', responseHeaders: 'content-type: application/json\r\n' });
            });
            return { abort() {} };
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
                if (!event.data.fixtureReload) return;
                self.postMessage({ key: 'ReloadPlayer', kind: event.data.kind, channelName: 'fixture-channel', sessionId: 1 });
                self.postMessage({ fixtureAck: true });
            });
            self.postMessage({ fixtureReady: true });
        `;
        const worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
        await new Promise(resolve => worker.addEventListener('message', event => { if (event.data.fixtureReady) resolve(); }));
        fixture.reload = kind => new Promise(resolve => {
            const ack = event => {
                if (!event.data.fixtureAck) return;
                worker.removeEventListener('message', ack);
                resolve();
            };
            worker.addEventListener('message', ack);
            worker.postMessage({ fixtureReload: true, kind });
        });
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
        test(script.file + ' runs shared recovery helpers inside the injected worker', async ({ page, context }) => {
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

        test(script.file + ' honors a worker hard reset near the native live edge', async ({ page, context }) => {
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

        for (const navigateDuringRecovery of [false, true]) {
            test(script.file + ' recovers the Drops mini-player, navigation during recovery=' + navigateDuringRecovery, async ({ page, context }) => {
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
            test(script.file + ' rolls back failed native-video recovery, user mute=' + userMute, async ({ page, context }) => {
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

        test(script.file + ' resumes and unmutes the replacement native video', async ({ page, context }) => {
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

        test(script.file + ' upgrades overlapping soft and hard browser recovery', async ({ page, context }) => {
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
            test(script.file + ' cancels native-video recovery for ' + reason, async ({ page, context }) => {
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

        test(script.file + ' handles optional GQL headers and v2 worker playlist failures', async ({ page, context }) => {
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

    test(script.file + ' boots once and preserves ordinary fetch and reused XHR', async ({ page, context }) => {
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
        test(script.file + ' leaves Twitch clip pages untouched', async ({ page, context }) => {
            await boot(page, context, script.file, 'https://www.twitch.tv/fixture-channel/clip/fixture');
            expect(await page.evaluate(() => ({
                version: window.twitchAdSolutionsVersion ?? window.twitchBraveFixVersion ?? null,
                fetchUnchanged: fetch === window.__nativeFetch,
                workerUnchanged: Worker === window.__nativeWorker
            }))).toEqual({ version: null, fetchUnchanged: true, workerUnchanged: true });
        });
    }

    if (script.file.includes('ublock-origin')) {
        test(script.file + ' ignores non-Twitch origins', async ({ page, context }) => {
            await boot(page, context, script.file, 'https://example.com/fixture');
            expect(await page.evaluate(() => ({
                version: window.twitchAdSolutionsVersion ?? window.twitchBraveFixVersion ?? null,
                fetchUnchanged: fetch === window.__nativeFetch,
                workerUnchanged: Worker === window.__nativeWorker
            }))).toEqual({ version: null, fetchUnchanged: true, workerUnchanged: true });
        });
    }

    if (script.worker) {
        test(script.file + ' runs its injected worker and replaces cached ad media', async ({ page, context }) => {
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
    test(file + ' masks Brave fingerprint properties', async ({ page, context }) => {
        await boot(page, context, file);
        expect(await page.evaluate(async () => ({
            braveHidden: navigator.brave === undefined,
            brands: navigator.userAgentData.brands,
            entropyBrands: (await navigator.userAgentData.getHighEntropyValues(['brands'])).brands
        }))).toEqual({ braveHidden: true, brands: [{ brand: 'Google Chrome', version: '156' }], entropyBrands: [{ brand: 'Google Chrome', version: '156' }] });
    });
}

for (const requestInput of [false, true]) {
    test('Brave userscript retries a rejected ' + (requestInput ? 'Request' : 'URL') + ' through the manager transport', async ({ page, context }) => {
        await boot(page, context, 'vaft/twitch-brave-fix.user.js');
        const result = await page.evaluate(async requestInput => {
            const url = 'https://gql.twitch.tv/gql';
            const init = { method: 'POST', body: '{"operationName":"Fixture"}' };
            const response = await (requestInput ? fetch(new Request(url, init)) : fetch(url, init));
            return { body: await response.json(), calls: window.__gmCalls };
        }, requestInput);
        expect(result.body).toEqual({ data: { fixture: true } });
        expect(result.calls).toHaveLength(1);
        expect(result.calls[0]).toMatchObject({ url: 'https://gql.twitch.tv/gql', method: 'POST', data: '{"operationName":"Fixture"}' });
        expect(result.calls[0].headers['Sec-Ch-Ua']).toContain('Google Chrome');
        expect(result.calls[0].headers['Sec-Ch-Ua']).not.toContain('Brave');
    });
}

test('Brave userscript preserves the original response when manager transport fails', async ({ page, context }) => {
    await boot(page, context, 'vaft/twitch-brave-fix.user.js');
    expect(await page.evaluate(async () => {
        window.__gmFail = true;
        return (await fetch('https://gql.twitch.tv/gql', { method: 'POST', body: '{}' })).json();
    })).toEqual({ errors: [{ message: 'fixture fingerprint rejection' }] });
});
