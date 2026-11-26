// Live background-tab check (issue #74). Opens a live channel in a real Chrome with a shipped script injected,
// hides the page, and samples playback through an ad break, then shows the page again and keeps sampling.
// It drives Chrome over the DevTools protocol directly: Playwright emulates focus, so document.hidden never
// becomes true there. Needs a Chrome or Edge build that decodes H.264. Results depend on Twitch serving an ad.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const USAGE = `Usage: npm run live:background -- <channel> [options]

Options:
  --script <file>       userscript to inject (default vaft/vaft.user.js)
  --chrome <path>       Chrome or Edge executable (default: CHROME_PATH, then a system install, then Playwright's Chromium)
  --hide <mode>         tab (default) | minimize | none
  --no-auto-pip         start Chrome with automatic Picture-in-Picture disabled (best effort)
  --seconds <n>         maximum hidden time before giving up on an ad break (default 300)
  --after-break <n>     seconds to keep the page hidden after the break ends (default 90)
  --visible <n>         seconds to sample after showing the page again (default 25)
  --out <dir>           output folder (default background-runs/<time>-<channel>)
  --port <n>            DevTools port (default 9333)

Exit code 0: an ad break ended while hidden and playback kept advancing. 1: a stall was recorded after the break.
2: no ad break ended while hidden, so the run proves nothing.`;

function parseArgs(argv) {
    const options = { script: 'vaft/vaft.user.js', chrome: null, hide: 'tab', autoPip: true, seconds: 300, afterBreak: 90, visible: 25, out: null, port: 9333 };
    const numbers = { '--seconds': 'seconds', '--after-break': 'afterBreak', '--visible': 'visible', '--port': 'port' };
    const strings = { '--script': 'script', '--chrome': 'chrome', '--hide': 'hide', '--out': 'out' };
    const positional = [];
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--no-auto-pip') { options.autoPip = false; continue; }
        if (arg === '--help' || arg === '-h') return { help: true };
        if (numbers[arg] || strings[arg]) {
            const value = argv[++i];
            if (value === undefined) throw new Error(arg + ' needs a value');
            if (numbers[arg]) {
                const number = Number(value);
                if (!Number.isFinite(number) || number < 0) throw new Error(arg + ' must be a non-negative number');
                options[numbers[arg]] = number;
            } else {
                options[strings[arg]] = value;
            }
            continue;
        }
        if (arg.startsWith('--')) throw new Error('Unknown option ' + arg);
        positional.push(arg);
    }
    if (positional.length !== 1) throw new Error('Expected exactly one channel');
    if (!/^[a-z0-9_]{2,25}$/.test(positional[0])) throw new Error('Channel must be a lowercase Twitch login');
    if (!['tab', 'minimize', 'none'].includes(options.hide)) throw new Error('--hide must be tab, minimize or none');
    options.channel = positional[0];
    return options;
}

// A stall is a sample where currentTime has not moved for at least stallSeconds. Frame counts are not used:
// Chrome stops decoding video for a hidden page while audio and currentTime keep going.
function summarize(samples, stallSeconds = 6) {
    const summary = { adSeen: false, adEndedHidden: false, stallsAfterBreak: 0, longestStallSeconds: 0, playingAfterShow: null };
    let lastTime = null, lastMoveAt = null, adEndAt = null;
    for (const sample of samples) {
        const time = sample.state?.time;
        if (time !== lastTime) { lastTime = time; lastMoveAt = sample.at; }
        if (sample.state?.inAdBreak) summary.adSeen = true;
        if (summary.adSeen && adEndAt === null && sample.state && !sample.state.inAdBreak) {
            adEndAt = sample.at;
            summary.adEndedHidden = sample.phase === 'hidden';
        }
        const stuck = lastMoveAt === null ? 0 : (sample.at - lastMoveAt) / 1000;
        if (adEndAt !== null && sample.phase === 'hidden' && stuck >= stallSeconds) {
            summary.stallsAfterBreak++;
            summary.longestStallSeconds = Math.max(summary.longestStallSeconds, Math.round(stuck));
        }
    }
    const shown = samples.filter(sample => sample.phase === 'shown' && sample.state);
    if (shown.length >= 2) {
        const last = shown[shown.length - 1].state, first = shown[0].state;
        summary.playingAfterShow = !last.paused && last.time !== first.time;
    }
    summary.exitCode = !summary.adEndedHidden ? 2 : summary.stallsAfterBreak > 0 ? 1 : 0;
    return summary;
}

function findChrome(requested) {
    const candidates = [requested, process.env.CHROME_PATH];
    if (process.platform === 'win32') {
        for (const base of [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean)) {
            candidates.push(path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
        }
    } else if (process.platform === 'darwin') {
        candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
    } else {
        candidates.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/microsoft-edge', '/usr/bin/chromium');
    }
    try { candidates.push(require('playwright').chromium.executablePath()); } catch {}
    const found = candidates.find(candidate => candidate && fs.existsSync(candidate));
    if (!found) throw new Error('No Chrome found. Pass --chrome <path> or set CHROME_PATH.');
    return found;
}

function connect(url) {
    const socket = new WebSocket(url);
    let id = 0;
    const pending = new Map(), listeners = [];
    socket.onmessage = event => {
        const message = JSON.parse(event.data);
        const request = message.id && pending.get(message.id);
        if (request) {
            pending.delete(message.id);
            if (message.error) request.reject(new Error(message.error.message || JSON.stringify(message.error)));
            else request.resolve(message.result);
        } else {
            listeners.forEach(listener => listener(message));
        }
    };
    return {
        ready: new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; }),
        on: listener => listeners.push(listener),
        send: (method, params = {}, sessionId) => new Promise((resolve, reject) => {
            pending.set(++id, { resolve, reject });
            socket.send(JSON.stringify({ id, method, params, sessionId }));
        }),
        close: () => socket.close()
    };
}

const SAMPLE = `(() => {
    const video = [...document.querySelectorAll('video')].find(element => !element.dataset.tasAdHidden);
    const current = window.__tasDiagnostics?.current;
    return { hidden: document.hidden, pip: !!document.pictureInPictureElement,
        time: video ? +video.currentTime.toFixed(2) : null, paused: video?.paused ?? null, readyState: video?.readyState ?? null,
        buffered: video && video.buffered.length ? +(video.buffered.end(video.buffered.length - 1) - video.currentTime).toFixed(1) : null,
        frames: video?.getVideoPlaybackQuality?.().totalVideoFrames ?? null,
        backup: current?.backup ?? null, recovery: current?.recovery ?? null, inAdBreak: current?.inAdBreak ?? null };
})()`;

async function run(options) {
    const started = Date.now();
    const stamp = new Date(started).toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const outDir = path.resolve(options.out || path.join('background-runs', stamp + '-' + options.channel));
    fs.mkdirSync(outDir, { recursive: true });
    const logFile = path.join(outDir, 'log.txt');
    const log = text => {
        const line = '[' + ((Date.now() - started) / 1000).toFixed(1) + 's] ' + text;
        fs.appendFileSync(logFile, line + '\n');
        console.log(line);
    };
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const source = fs.readFileSync(path.resolve(options.script), 'utf8');
    const executable = findChrome(options.chrome);
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tas-background-'));
    const args = ['--remote-debugging-port=' + options.port, '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check',
        '--autoplay-policy=no-user-gesture-required', '--window-size=1280,800'];
    if (!options.autoPip) args.push('--disable-features=AutoPictureInPictureForVideoPlayback,BrowserInitiatedAutomaticPictureInPicture');
    const chrome = spawn(executable, [...args, 'about:blank'], { stdio: 'ignore' });
    const samples = [];
    let browser;
    try {
        let version = null;
        for (let i = 0; i < 75 && !version; i++) {
            await sleep(200);
            version = await fetch('http://127.0.0.1:' + options.port + '/json/version').then(response => response.json()).catch(() => null);
        }
        if (!version) throw new Error('Chrome did not open DevTools on port ' + options.port);
        browser = connect(version.webSocketDebuggerUrl);
        await browser.ready;
        const { targetInfos } = await browser.send('Target.getTargets');
        const pageTarget = targetInfos.find(target => target.type === 'page').targetId;
        const { sessionId } = await browser.send('Target.attachToTarget', { targetId: pageTarget, flatten: true });
        const evaluate = async expression => (await browser.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)).result.value;
        await browser.send('Page.enable', {}, sessionId);
        await browser.send('Runtime.enable', {}, sessionId);
        browser.on(message => {
            if (message.sessionId !== sessionId) return;
            if (message.method === 'Runtime.consoleAPICalled') {
                const text = (message.params.args || []).map(arg => arg.value ?? arg.description ?? '').join(' ');
                if (text.includes('[AD DEBUG]') && !text.includes('nested frame')) log('console ' + text.slice(0, 300));
            } else if (message.method === 'Runtime.exceptionThrown') {
                log('exception ' + String(message.params.exceptionDetails?.exception?.description || '').slice(0, 200));
            }
        });
        if (!await evaluate(`MediaSource.isTypeSupported('video/mp4; codecs="avc1.4d401f"')`)) {
            throw new Error('This browser cannot decode H.264, which Twitch needs. Pass --chrome with a Chrome or Edge build.');
        }
        await browser.send('Page.addScriptToEvaluateOnNewDocument', { source }, sessionId);
        log('browser ' + version.Browser + ', script ' + options.script + ', hide ' + options.hide + ', auto PiP ' + (options.autoPip ? 'on' : 'off'));
        const record = async phase => {
            const state = await evaluate(SAMPLE).catch(error => ({ error: String(error.message || error).slice(0, 120) }));
            const sample = { at: Date.now(), phase, state: state.error ? null : state };
            samples.push(sample);
            log(phase + ' ' + JSON.stringify(state));
            return sample;
        };
        await browser.send('Page.navigate', { url: 'https://www.twitch.tv/' + options.channel }, sessionId);
        await sleep(5000);
        await record('visible');
        let windowId = null;
        if (options.hide === 'minimize') {
            ({ windowId } = await browser.send('Browser.getWindowForTarget', { targetId: pageTarget }));
            await browser.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
        } else if (options.hide === 'tab') {
            const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
            await browser.send('Target.activateTarget', { targetId });
        }
        await sleep(1500);
        const deadline = Date.now() + options.seconds * 1000;
        let adEndAt = null;
        while (Date.now() < deadline) {
            const sample = await record(options.hide === 'none' ? 'visible' : 'hidden');
            if (sample.state?.inAdBreak === false && samples.some(entry => entry.state?.inAdBreak) && adEndAt === null) {
                adEndAt = Date.now();
                log('ad break ended');
            }
            if (adEndAt !== null && Date.now() - adEndAt >= options.afterBreak * 1000) break;
            await sleep(3000);
        }
        const exportDiagnostics = async name => {
            const diagnostics = await evaluate('JSON.stringify(window.twitchAdSolutionsTools?.diagnostics?.() ?? null)').catch(() => 'null');
            fs.writeFileSync(path.join(outDir, name), diagnostics);
        };
        await exportDiagnostics('diagnostics-hidden.json');
        if (options.hide === 'minimize') await browser.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
        else if (options.hide === 'tab') await browser.send('Target.activateTarget', { targetId: pageTarget });
        for (let elapsed = 0; elapsed < options.visible * 1000; elapsed += 2500) {
            await sleep(2500);
            await record('shown');
        }
        await exportDiagnostics('diagnostics-shown.json');
    } finally {
        if (browser) {
            await browser.send('Browser.close').catch(() => {});
            browser.close();
        }
        chrome.kill();
        await sleep(500);
        try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
    }
    const summary = summarize(samples);
    fs.writeFileSync(path.join(outDir, 'samples.json'), JSON.stringify(samples, null, 2));
    fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
    log('summary ' + JSON.stringify(summary));
    log('results in ' + outDir);
    return summary;
}

if (require.main === module) {
    let options;
    try {
        options = parseArgs(process.argv.slice(2));
    } catch (error) {
        console.error(error.message + '\n\n' + USAGE);
        process.exit(64);
    }
    if (options.help) {
        console.log(USAGE);
    } else {
        run(options).then(summary => { process.exitCode = summary.exitCode; }, error => {
            console.error('Background run failed: ' + error.message);
            process.exitCode = 70;
        });
    }
}

module.exports = { parseArgs, summarize };
