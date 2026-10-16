twitch-brave-fix.js text/javascript
// TwitchAdSolutions (twitch-brave-fix) — uBlock Origin scriptlet variant of vaft/twitch-brave-fix.user.js
// JS-surface Brave fingerprint defenses only. The userscript variant additionally retries failed
// requests via GM_xmlHttpRequest with header spoofs (Sec-Ch-Ua, User-Agent, etc.) — that path
// cannot run in a uBO scriptlet because GM.xmlHttpRequest is a userscript-manager API and the
// browser silently drops attempts to set forbidden request headers from page-world fetch/XHR.
// If Twitch login still fails on Brave with this scriptlet alone, install the .user.js variant.
(function() {
    if (/(^|\.)twitch\.tv$/.test(document.location.hostname) === false) return;
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
    const ourVersion = 8;
    console.log('[TwitchBraveFix-uBO] v1.3.4 loading');
    // The userscript can add its retry transport after this diagnostic helper loads.
    if (typeof window.twitchBraveFixVersion !== 'undefined' && window.twitchBraveFixVersion >= ourVersion) {
        console.log('[TwitchBraveFix-uBO] CONFLICT: skipped — another instance already active (v' + window.twitchBraveFixVersion + ')');
        return;
    }
    window.twitchBraveFixVersion = ourVersion;

    // Hide navigator.brave before Twitch's bundle runs so navigator.brave.isBrave() can't
    // preemptively flag the session. Brave exposes this property even in Strict shields mode,
    // so it's the most reliable Brave detector. The standard isBrave pattern short-circuits
    // cleanly on `undefined`.
    try {
        if ('brave' in navigator) {
            Object.defineProperty(navigator, 'brave', {
                get: () => undefined,
                configurable: true,
            });
        }
    } catch (_e) { /* non-configurable on some Brave builds; accept the risk */ }

    // Rebrand navigator.userAgentData so in-page JS checking the brands array sees "Google Chrome"
    // instead of "Brave". Twitch can call getHighEntropyValues(['brands']) directly to fingerprint
    // the session — overrides both the sync `brands` getter and the async `getHighEntropyValues`
    // result (rebranding both `brands` and `fullVersionList`). Runs synchronously at injection
    // time; uBO scriptlets inject at document-start, so this lands before Twitch's bundle.
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
    } catch (_e) { /* read-only on some builds — fall through */ }

    // Diagnostic fetch hook — no recovery path here, just surfaces a single console line
    // when Twitch's gateway returns an explicit integrity rejection without data.
    // Tells the user that JS-surface spoofs alone weren't enough for this session
    // and the userscript variant (with GM xhr header retry) is needed. Logs once per page
    // load to avoid spam.
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

    let _errorReported = false;
    async function _checkForErrors(url, response) {
        if (_errorReported || response.status !== 200) return response;
        const cloned = response.clone();
        let bodyText;
        try { bodyText = await cloned.text(); } catch (_e) { return response; }
        let parsed;
        try { parsed = JSON.parse(bodyText); } catch (_e) { return response; }
        if (isIntegrityRejection(parsed)) {
            _errorReported = true;
            console.log('[TwitchBraveFix-uBO] DETECTED integrity rejection on ' + url.replace(/\?.*$/, '')
                + ' — JS-surface spoofs were insufficient for this session. The .user.js variant '
                + 'retries via GM_xmlHttpRequest with full header spoofs; install it if Twitch '
                + 'login or playback fails persistently.');
        }
        return response;
    }

    window.fetch = function _braveFixFetchUbo(input, init) {
        try {
            const url = typeof input === 'string' ? input : (input && input.url) || '';
            if (!isInterceptable(url)) return realFetch.call(this, input, init);
            return realFetch.call(this, input, init).then(resp => _checkForErrors(url, resp));
        } catch (e) {
            return Promise.reject(e);
        }
    };

    console.log('[TwitchBraveFix-uBO] navigator.brave hidden + userAgentData rebranded + diagnostic fetch hook installed');
})();
