// ==UserScript==
// @name         TwitchAdSolutions (twitch-brave-fix)
// @namespace    https://github.com/ryanbr/TwitchAdSolutions
// @version      1.3.5
// @description  Bypass Brave fingerprint detection on Twitch GQL/integrity requests by retrying via GM_xmlHttpRequest with header spoofs (Sec-Ch-Ua brand rewrite from Brave to Google Chrome with synthetic fallback when userAgentData hidden, Sec-Ch-Ua-Platform, Sec-Ch-Ua-Mobile, Firefox User-Agent, explicit Origin/Referer, Accept-Language). Also hides navigator.brave and rebrands navigator.userAgentData.brands / getHighEntropyValues from "Brave" to "Google Chrome" so Twitch JS can't preemptively flag the session. Per-request retry: each interceptable request goes native first, retries explicit integrity rejections via GM xhr only when the entire response has no data or ordinary GraphQL errors — fixes occasional fingerprint-driven failures (e.g. Brave login on www.twitch.tv) without paying the GM xhr tax on every successful request. Companion to vaft / video-swap-new. A uBlock Origin scriptlet variant (twitch-brave-fix-ublock-origin.js) is also available but covers JS-surface spoofs only — the GM xhr header-retry path is userscript-exclusive (Tampermonkey / Violentmonkey / Greasemonkey 4+).
// @updateURL    https://github.com/xBandaku/TwitchAdSolutions/raw/master/vaft/twitch-brave-fix.user.js
// @downloadURL  https://github.com/xBandaku/TwitchAdSolutions/raw/master/vaft/twitch-brave-fix.user.js
// @author       https://github.com/ryanbr/TwitchAdSolutions
// @match        *://*.twitch.tv/*
// @run-at       document-start
// @grant        GM_xmlHttpRequest
// @grant        GM.xmlHttpRequest
// @connect      gql.twitch.tv
// @connect      passport.twitch.tv
// ==/UserScript==
(function() {
    let _isNested = false;
    try { _isNested = window.frameElement !== null; } catch (_e) { _isNested = true; }
    if (_isNested) {
        const _host = document.location.hostname;
        const _isEmbedContext = _host === 'player.twitch.tv' || _host === 'embed.twitch.tv' || document.location.pathname.startsWith('/embed/');
        if (!_isEmbedContext) return;
    }
    {
        const _clipHost = document.location.hostname;
        const _clipPath = document.location.pathname || '';
        if (_clipHost === 'clips.twitch.tv' || /^\/[^/]+\/clip\/[^/]+/.test(_clipPath)) return;
    }
    'use strict';
    const ourVersion = 9;
    console.log('[TwitchBraveFix] v1.3.5 loading');
    if (typeof window.twitchBraveFixRetryVersion !== 'undefined' && window.twitchBraveFixRetryVersion >= ourVersion) {
        console.log('[TwitchBraveFix] CONFLICT: skipped — another instance already active (v' + window.twitchBraveFixRetryVersion + ')');
        return;
    }

    // Hide navigator.brave before Twitch's bundle runs so navigator.brave.isBrave() can't preemptively
    // flag the session. Brave exposes this property even in Strict shields mode, so it's the most
    // reliable Brave detector. The standard isBrave pattern short-circuits cleanly on `undefined`.
    try {
        if ('brave' in navigator) {
            Object.defineProperty(navigator, 'brave', {
                get: () => undefined,
                configurable: true,
            });
        }
    } catch (_e) { /* non-configurable on some Brave builds; accept the risk and rely on header spoofs */ }

    // Rebrand navigator.userAgentData so in-page JS checking the brands array sees "Google Chrome"
    // instead of "Brave". Twitch can call getHighEntropyValues(['brands']) directly to fingerprint
    // the session — the Sec-Ch-Ua header spoof on outgoing requests doesn't cover that JS surface.
    // Runs synchronously at document-start before Twitch's bundle loads.
    try {
        const uaData = navigator.userAgentData;
        if (uaData) {
            const rebrand = (arr) => Array.isArray(arr)
                ? arr.map(b => b.brand === 'Brave'
                    ? { brand: 'Google Chrome', version: b.version }
                    : b)
                : arr;
            const spoofedBrands = Object.freeze(rebrand(uaData.brands));
            Object.defineProperty(uaData, 'brands', {
                get: () => spoofedBrands,
                configurable: true,
            });
            const origGHEV = uaData.getHighEntropyValues;
            if (typeof origGHEV === 'function') {
                uaData.getHighEntropyValues = function(hints) {
                    return origGHEV.call(this, hints).then(result => {
                        if (result && Array.isArray(result.brands))
                            result.brands = rebrand(result.brands);
                        if (result && Array.isArray(result.fullVersionList))
                            result.fullVersionList = rebrand(result.fullVersionList);
                        return result;
                    });
                };
            }
        }
    } catch (_e) { /* read-only on some builds — fall through to header-only spoof */ }

    const gmXhr = (typeof GM !== 'undefined' && typeof GM.xmlHttpRequest === 'function') ? GM.xmlHttpRequest
                : (typeof GM_xmlHttpRequest === 'function') ? GM_xmlHttpRequest
                : null;
    if (!gmXhr) {
        console.log('[TwitchBraveFix] GM.xmlHttpRequest unavailable — install via Tampermonkey, Violentmonkey, or Greasemonkey 4+ for the fallback to work. Stopping.');
        return;
    }

    window.twitchBraveFixVersion = Math.max(window.twitchBraveFixVersion || 0, ourVersion);
    window.twitchBraveFixRetryVersion = ourVersion;
    const realFetch = window.fetch;

    function isInterceptable(url) {
        if (typeof url !== 'string') return false;
        try {
            const parsed = new URL(url, document.location.href);
            if (parsed.protocol !== 'https:' || parsed.port || parsed.username || parsed.password) return false;
            return (parsed.hostname === 'gql.twitch.tv' && (parsed.pathname === '/gql' || parsed.pathname === '/integrity'))
                || (parsed.hostname === 'passport.twitch.tv' && parsed.pathname === '/integrity');
        } catch (_e) {
            return false;
        }
    }

    // Spoof values are derived from navigator.userAgent / navigator.userAgentData, which don't
    // change mid-session. Compute once at init so per-retry header assembly is just object copies.
    const SPOOF = (() => {
        const ua = navigator.userAgent;
        const chromeMatch = ua.match(/Chrome\/(\d+)/);
        const chromeMajor = chromeMatch && chromeMatch[1] ? parseInt(chromeMatch[1], 10) : 138;

        let platform;
        if (/Android/i.test(ua)) platform = '"Android"';
        else if (/iPhone|iPad|iPod/i.test(ua)) platform = '"iOS"';
        else if (/Windows/i.test(ua)) platform = '"Windows"';
        else if (/Mac OS X|Macintosh/i.test(ua)) platform = '"macOS"';
        else if (/Linux/i.test(ua)) platform = '"Linux"';
        else platform = '"Windows"';

        const mobile = /Mobile/.test(ua) ? '?1' : '?0';

        const platformMatch = ua.match(/\(([^)]+)\)/);
        const platformInner = platformMatch ? platformMatch[1] : 'Windows NT 10.0; Win64; x64';
        const firefoxVersion = chromeMajor + 2;
        const firefoxUA = 'Mozilla/5.0 (' + platformInner + '; rv:' + firefoxVersion
                        + '.0) Gecko/20100101 Firefox/' + firefoxVersion + '.0';

        // Synthetic Chrome-N Sec-Ch-Ua used when navigator.userAgentData is hidden (Brave Strict
        // mode) or unavailable. Format matches what real Chromium ships, so the absence of "Brave"
        // looks natural.
        const syntheticSecChUa = '"Not_A Brand";v="99", "Google Chrome";v="' + chromeMajor
                               + '", "Chromium";v="' + chromeMajor + '"';

        return { chromeMajor, platform, mobile, firefoxUA, syntheticSecChUa };
    })();

    // Cached promise — getHighEntropyValues() is async but the result is stable, so we resolve
    // it once on first need and reuse the same promise for every subsequent retry.
    let _secChUaPromise = null;
    function getSpoofedSecChUa() {
        if (_secChUaPromise) return _secChUaPromise;
        _secChUaPromise = (async () => {
            const uaData = navigator.userAgentData;
            if (uaData && typeof uaData.getHighEntropyValues === 'function') {
                try {
                    const { brands } = await uaData.getHighEntropyValues(['brands']);
                    if (brands && brands.length) {
                        return brands.map(b => {
                            const brand = b.brand === 'Brave' ? 'Google Chrome' : b.brand;
                            return '"' + brand + '";v="' + b.version + '"';
                        }).join(', ');
                    }
                } catch (_e) { /* fall through to synthetic */ }
            }
            return SPOOF.syntheticSecChUa;
        })();
        return _secChUaPromise;
    }

    function parseRawHeaders(headersStr) {
        const headers = new Headers();
        if (!headersStr) return headers;
        const lines = headersStr.trim().split(/[\r\n]+/);
        for (const line of lines) {
            const idx = line.indexOf(':');
            if (idx < 0) continue;
            const name = line.slice(0, idx).trim();
            const value = line.slice(idx + 1).trim();
            if (name) {
                try { headers.append(name, value); } catch (_e) { /* skip illegal header names from set-cookie etc. */ }
            }
        }
        return headers;
    }

    function gmRespToFetchResp(gmResp) {
        return new Response(gmResp.responseText || '', {
            status: gmResp.status || 0,
            statusText: gmResp.statusText || '',
            headers: parseRawHeaders(gmResp.responseHeaders),
        });
    }

    async function readRetryBody(request) {
        // Firefox can read the body even when Request.body is unavailable.
        if (request.method === 'GET' || request.method === 'HEAD') return undefined;
        const type = request.headers.get('content-type') || '';
        return /^(?:text\/|application\/(?:json|x-www-form-urlencoded))/i.test(type)
            ? request.text() : request.arrayBuffer();
    }

    async function gmRetry(url, method, bodyText, baseHeaders, signal) {
        signal?.throwIfAborted();
        const spoofedSecChUa = await getSpoofedSecChUa();
        signal?.throwIfAborted();
        const headers = Object.assign({}, baseHeaders || {});
        if (spoofedSecChUa) headers['Sec-Ch-Ua'] = spoofedSecChUa;
        headers['Sec-Ch-Ua-Mobile'] = SPOOF.mobile;
        headers['Sec-Ch-Ua-Platform'] = SPOOF.platform;
        headers['User-Agent'] = SPOOF.firefoxUA;
        headers['Accept-Language'] = 'en-US,en;q=0.9';
        headers['Referer'] = 'https://www.twitch.tv/';
        headers['Origin'] = 'https://www.twitch.tv/';
        return new Promise((resolve, reject) => {
            let request;
            let settled = false;
            const finish = (settle, value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeoutId);
                signal?.removeEventListener('abort', abort);
                settle(value);
            };
            const abort = () => {
                finish(reject, signal.reason);
                request?.abort?.();
            };
            const timeoutMs = 15000;
            const timeoutId = setTimeout(() => {
                finish(reject, new DOMException('TwitchBraveFix: GM_xmlHttpRequest timeout', 'TimeoutError'));
                request?.abort?.();
            }, timeoutMs);
            signal?.addEventListener('abort', abort, { once: true });
            try {
                request = gmXhr({
                    method: method || 'GET',
                    url: url,
                    data: bodyText,
                    headers: headers,
                    timeout: timeoutMs,
                    onload: resp => finish(resolve, resp),
                    onerror: err => finish(reject, err),
                    onabort: () => finish(reject, new DOMException('The request was aborted', 'AbortError')),
                    ontimeout: () => finish(reject, new DOMException('TwitchBraveFix: GM_xmlHttpRequest timeout', 'TimeoutError'))
                });
                if (typeof request?.then === 'function') request.then(resp => finish(resolve, resp), err => finish(reject, err));
            } catch (error) {
                finish(reject, error);
            }
        });
    }

    // A GraphQL execution error is not evidence of fingerprint rejection. Replay
    // only a wholly rejected response; even data:null can indicate partial execution.
    function isIntegrityRejection(parsed) {
        const responses = Array.isArray(parsed) ? parsed : [parsed];
        return responses.length > 0 && responses.every(response =>
            response && typeof response === 'object' && !('data' in response)
            && Array.isArray(response.errors) && response.errors.length > 0
            && response.errors.every(error => typeof error?.message === 'string'
                && /^(?:failed (?:client )?integrity check|(?:client )?integrity check failed|invalid (?:client )?integrity token|fingerprint validation failed)[.!]?$/i.test(error.message.trim())));
    }

    async function maybeRetryOnErrors(url, method, headers, response, readBody, signal) {
        if (response.status !== 200) return response;
        const cloned = response.clone();
        let bodyTextResp;
        try { bodyTextResp = await cloned.text(); } catch (_e) { return response; }
        let parsed;
        try { parsed = JSON.parse(bodyTextResp); } catch (_e) { return response; }
        if (!isIntegrityRejection(parsed)) return response;
        console.log('[TwitchBraveFix] Integrity rejection detected on ' + url.replace(/\?.*$/, '') + ' — retrying via GM_xmlHttpRequest with header spoofs');
        // Body is only needed on the retry path — defer the clone-and-decode until now so the
        // happy path doesn't pay for it on every interceptable request.
        try {
            const bodyText = await readBody();
            const gmResp = await gmRetry(url, method, bodyText, headers, signal);
            return gmRespToFetchResp(gmResp);
        } catch (e) {
            signal?.throwIfAborted();
            console.log('[TwitchBraveFix] GM_xmlHttpRequest retry failed; returning original errored response:', (e && e.message) || e);
            return new Response(bodyTextResp, {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
            });
        }
    }

    // Sync outer wrapper so the ~99% non-interceptable hot path skips async-function promise
    // wrapping and inliner-hostile `arguments` access. The try/catch preserves the
    // "fetch never throws synchronously, always returns a Promise" contract for any caller
    // using `.catch()` without a preceding `.then()`.
    async function _interceptedFetch(input, init) {
        const request = new Request(input instanceof Request ? input : new URL(input, document.location.href), init);
        const bodyClone = request.clone();
        const headers = Object.fromEntries(request.headers);
        const response = await realFetch.call(this, request);
        return maybeRetryOnErrors(request.url, request.method, headers, response,
            () => readRetryBody(bodyClone), request.signal);
    }

    window.fetch = function _braveFixFetch(input, init) {
        try {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input && input.url) || '';
            if (!isInterceptable(url)) {
                return realFetch.call(this, input, init);
            }
            return _interceptedFetch.call(this, input, init);
        } catch (e) {
            return Promise.reject(e);
        }
    };

    console.log('[TwitchBraveFix] window.fetch hook installed + navigator.brave hidden + userAgentData rebranded — per-request retry: native fetch first, retry via GM_xmlHttpRequest only for wholly rejected integrity responses');
})();
