twitch-videoad.js text/javascript
(function() {
    if ( /(^|\.)twitch\.tv$/.test(document.location.hostname) === false ) { return; }
    // Skip injection in nested frames that aren't legitimate Twitch embed contexts.
    // Twitch's main channel page has 5+ hidden cross-origin iframes (auth, analytics,
    // ad SDK, etc.) and uBO injects into all matching ones. Each becomes a racing instance
    // that fights for player control. Only the top frame hosts the player on twitch.tv/CHANNEL;
    // nested auxiliary frames are noise.
    // Allow-list for nested-frame injection: Twitch's three documented embed contexts
    // (https://dev.twitch.tv/docs/embed/video-and-clips/) — preserves Twitch streams
    // embedded on third-party sites where the script runs in an iframe whose parent
    // is on a different origin.
    // Use window.frameElement to detect nested frames — null on top frame, the iframe
    // element on a same-origin nested frame, throws on a cross-origin nested frame.
    // More reliable than 'window !== window.top' because Tampermonkey wraps window in a
    // proxy where the strict comparison can return true even on the top frame.
    let _isNested = false;
    try { _isNested = window.frameElement !== null; } catch (_e) { _isNested = true; }
    if (_isNested) {
        const _host = document.location.hostname;
        const _isEmbedContext = _host === 'player.twitch.tv' || _host === 'embed.twitch.tv' || document.location.pathname.startsWith('/embed/');
        if (!_isEmbedContext) {
            console.log('[AD DEBUG] video-swap-new skipped — nested frame on ' + _host + document.location.pathname + ' (not a Twitch embed). If you see this on twitch.tv/CHANNEL top frame, please report.');
            return;
        }
    }
    // Skip injection on the Twitch clip editor — clips.twitch.tv host or /<channel>/clip/<slug> path.
    // Our fetch/Worker hooks and buffer monitor are aimed at the live channel player; on the
    // clip editor's seekable preview they have no ads to act on and have caused the preview
    // to freeze when the user drags the trim range. (Sync'd with TTV-AB v6.4.9.)
    {
        const _clipHost = document.location.hostname;
        const _clipPath = document.location.pathname || '';
        if (_clipHost === 'clips.twitch.tv' || /^\/[^/]+\/clip\/[^/]+/.test(_clipPath)) {
            console.log('[AD DEBUG] video-swap-new skipped — clip editor page (' + _clipHost + _clipPath + ').');
            return;
        }
    }
    const ourTwitchAdSolutionsVersion = 59;// Used to prevent conflicts with outdated versions of the scripts
    console.log('[AD DEBUG] TwitchAdSolutions video-swap-new v' + ourTwitchAdSolutionsVersion + ' loading');
    if (typeof window.twitchAdSolutionsVersion !== 'undefined' && window.twitchAdSolutionsVersion >= ourTwitchAdSolutionsVersion) {
        console.log('[AD DEBUG] CONFLICT: video-swap-new v' + ourTwitchAdSolutionsVersion + ' skipped — another script already active (v' + window.twitchAdSolutionsVersion + '). Remove duplicate scripts.');
        return;
    }
    window.twitchAdSolutionsVersion = ourTwitchAdSolutionsVersion;
    function declareOptions(scope) {
        // Options / globals
        // 'embed' moved to end — field-observed Twitch returns GQL 'server error' for
        // streamPlaybackAccessToken on embed when requested from twitch.tv origin.
        scope.OPT_BACKUP_PLAYER_TYPES = [ 'popout', 'mobile_web', 'embed' ];
        scope.OPT_FORCE_ACCESS_TOKEN_PLAYER_TYPE = 'popout';
        // 'twitch-stitched' catches the twitch-stitched-* DATERANGE class family
        // (-ad, -mid, -pod, etc.) without requiring an exact -ad suffix. Twitch-
        // prefixed so we don't re-introduce the PR #120 false-positive from bare
        // 'stitched' substring match.
        scope.AD_SIGNIFIERS = ['stitched-ad', 'EXT-X-CUE-OUT', 'twitch-stitched', 'EXT-X-DATERANGE:CLASS="twitch-maf-ad"', 'EXT-X-DATERANGE:CLASS="twitch-trigger"'];
        // Confirmed session/source metadata, never ad markers — filter from candidate log.
        scope.KNOWN_NON_AD_SIGNIFIERS = ['twitch-session', 'twitch-stream-source', 'twitch-ad-quartile', 'twitch-assignment'];
        scope.AD_SEGMENT_URL_PATTERNS = ['/adsquared/', '/_404/', '/processing'];
        // Precompiled regexes shared across the stripAdSegments hot path. Declared
        // here (serialized into the worker blob with declareOptions) so literals
        // inside the per-line strip loop don't recompile on every iteration.
        scope.TWITCH_AD_URL_REWRITE_REGEX = /(X-TV-TWITCH-AD(?:-[A-Z]+)*-URLS?=")[^"]*(")/g;
        scope.URI_ATTRIBUTE_REGEX = /URI="([^"]+)"/;
        scope.LIVE_SIGNIFIER = ',live';
        scope.CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
        // These are only really for Worker scope...
        scope.StreamInfos = Object.create(null);
        scope.StreamInfosByUrl = Object.create(null);
        // Need this in both scopes. Window scope needs to update this to worker scope.
        scope.gql_device_id = null;
        scope.ClientIntegrityHeader = null;
        scope.AuthorizationHeader = undefined;
        scope.SimulatedAdsDepth = 0;
        scope.V2API = false;
        scope.IsAdStrippingEnabled = true;
        scope.AdSegmentCache = new Map();
        scope.AllSegmentsAreAdSegments = false;
        scope.ReloadPlayerAfterAd = true;// After the ad finishes do a player reload instead of pause/play
        scope.ReloadCooldownSeconds = 30;// Minimum seconds between reloads — breaks CSAI cascades triggered by reload
        scope.EarlyReloadPollThreshold = 5;// All-stripped polls before early reload (~2s each, so 5 = ~10s; 0 = disable)
        scope.PinBackupPlayerType = false;// If true, remember which backup player type worked and try it first on next ad break
        scope.StreamInfoMaxAgeMs = 30 * 60 * 1000;
    }
    function createStreamInfo(channelName, usherParams) {
        return {
            ChannelName: channelName,
            LastSeenAt: Date.now(),
            UsherParams: usherParams,
            Urls: new Map(),
            RequestedAds: new Set(),
            Encodings: null,
            BackupQuality: 'unknown',
            BackupEncodings: null,
            BackupEncodingsStatus: new Map(),
            BackupEncodingsPlayerTypeIndex: -1,
            PinnedBackupPlayerType: null,
            HasCheckedUnknownTags: false,
            HasConfirmedAdAttrs: false,
            HasLoggedAdAttributes: false,
            HasLoggedUnknownSignifiers: false,
            IsMovingOffBackupEncodings: false,
            IsMidroll: false,
            IsStrippingAdSegments: false,
            NumStrippedAdSegments: 0,
            RecoverySegments: [],
            RecoveryM3U8: null,
            RecoveryStartSeq: undefined,
            CleanPlaylistCount: 0,
            PendingAdEndAt: 0,// Timestamp of first clean backup-poll seen this break — drives the bounce-tolerant max-wait escalation gate (TTV-AB v6.6.7 #1/#4)
            AdEndBounceCount: 0,// Count of ad-marker bounces while PendingAdEndAt is alive — telemetry only
            ConsecutiveZeroStripBreaks: 0,
            UseFallbackStream: false,
            LastCleanNativeM3U8: null,
            LastCleanNativePlaylistAt: 0,
            // Early reload + cooldown
            ConsecutiveAllStrippedPolls: 0,
            EarlyReloadTriggered: false,
            LastPlayerReload: 0,
            ReloadTimestamps: [],
            // Detection diagnostics
            LoggedOfflineTransition: false,
            ConsecutiveTokenFetchFailures: 0,
            LoggedTokenFailureStreak: false,
        };
    }
    function maskAsNative(fn, name) {
        fn.toString = () => 'function ' + name + '() { [native code] }';
        return fn;
    }
    function pruneStreamInfos() {
        const now = Date.now();
        for (const channelName in StreamInfos) {
            const streamInfo = StreamInfos[channelName];
            if (!streamInfo || !streamInfo.LastSeenAt || (now - streamInfo.LastSeenAt) > StreamInfoMaxAgeMs) {
                if (streamInfo && streamInfo.Urls) {
                    streamInfo.Urls.forEach((_, url) => { delete StreamInfosByUrl[url]; });
                }
                delete StreamInfos[channelName];
            }
        }
    }
    const loggedCsaiTypes = new Set();
    let twitchPlayerAndState = null;
    let localStorageHookFailed = false;
    let lastReloadTimestamp = 0;
    let reloadTimestamps = [];
    let EscalatedFromCooldown = null;// tracks pre-escalation value so we can revert when the burst subsides
    const twitchWorkers = [];
    const workerStringConflicts = [
        'twitch',
        'isVariantA'// TwitchNoSub
    ];
    const workerStringAllow = [];
    const workerStringReinsert = [
        'isVariantA',// TwitchNoSub (prior to (0.9))
        'besuper/',// TwitchNoSub (0.9)
        '${patch_url}'// TwitchNoSub (0.9.1)
    ];
    function getCleanWorker(worker) {
        let root = null;
        let parent = null;
        let proto = worker;
        while (proto) {
            const workerString = proto.toString();
            if (workerStringConflicts.some((x) => workerString.includes(x)) && !workerStringAllow.some((x) => workerString.includes(x))) {
                if (parent !== null) {
                    // Foreign extension may have frozen Worker.prototype; per-link try-catch.
                    try { Object.setPrototypeOf(parent, Object.getPrototypeOf(proto)); } catch {}
                }
            } else {
                if (root === null) {
                    root = proto;
                }
                parent = proto;
            }
            proto = Object.getPrototypeOf(proto);
        }
        return root;
    }
    function getWorkersForReinsert(worker) {
        const result = [];
        let proto = worker;
        while (proto) {
            const workerString = proto.toString();
            if (workerStringReinsert.some((x) => workerString.includes(x))) {
                result.push(proto);
            } else {
            }
            proto = Object.getPrototypeOf(proto);
        }
        return result;
    }
    function reinsertWorkers(worker, reinsert) {
        let parent = worker;
        for (let i = 0; i < reinsert.length; i++) {
            // Per-link try-catch: foreign-frozen entry shouldn't abort the chain.
            try { Object.setPrototypeOf(reinsert[i], parent); } catch {}
            parent = reinsert[i];
        }
        return parent;
    }
    function isValidWorker(worker) {
        const workerString = worker.toString();
        const hasConflict = workerStringConflicts.some((x) => workerString.includes(x));
        const hasAllow = workerStringAllow.some((x) => workerString.includes(x));
        const hasReinsert = workerStringReinsert.some((x) => workerString.includes(x));
        if (hasConflict && !hasAllow && !hasReinsert) {
            console.log('[AD DEBUG] Worker rejected — conflict string found: ' + workerStringConflicts.filter((x) => workerString.includes(x)).join(', '));
        }
        return !hasConflict || hasAllow || hasReinsert;
    }
    let injectedBlobUrl = null;
    let originalRevokeObjectURL = null;
    function hookWindowWorker() {
        // Prevent Twitch from revoking our injected worker blob URL
        if (!URL.revokeObjectURL.__tasMasked) {
            originalRevokeObjectURL = URL.revokeObjectURL;
            URL.revokeObjectURL = maskAsNative(function(url) {
                if (url === injectedBlobUrl) return;
                return originalRevokeObjectURL.call(this, url);
            }, 'revokeObjectURL');
            URL.revokeObjectURL.__tasMasked = true;
        }
        const reinsert = getWorkersForReinsert(window.Worker);
        const newWorker = class Worker extends (getCleanWorker(window.Worker) || window.Worker) {
            constructor(twitchBlobUrl, options) {
                let isTwitchWorker = false;
                try {
                    isTwitchWorker = new URL(twitchBlobUrl).origin.endsWith('.twitch.tv');
                } catch {}
                if (!isTwitchWorker) {
                    super(twitchBlobUrl, options);
                    console.log('[AD DEBUG] Non-Twitch worker skipped: ' + twitchBlobUrl);
                    return;
                }
                // Pre-check: verify we can fetch the worker JS before injecting
                let prefetchedWorkerJs = null;
                try { prefetchedWorkerJs = getWasmWorkerJs(twitchBlobUrl); } catch {}
                if (!prefetchedWorkerJs) {
                    super(twitchBlobUrl, options);
                    console.log('[AD DEBUG] Failed to fetch worker JS — falling back to unmodified worker');
                    return;
                }
                // Blob already carries our hooks: re-injecting would install
                // hookWorkerFetch twice and double-process every m3u8 response.
                // Reuse it as-is, but still register below so its messages are heard.
                const alreadyHooked = prefetchedWorkerJs.includes('hookWorkerFetch');
                const newBlobStr = `
                    const pendingFetchRequests = new Map();
                    ${hasAdTags.toString()}
                    ${getMatchedAdSignifiers.toString()}
                    ${stripAdSegments.toString()}
                    ${resolvePlaylistUrls.toString()}
                    ${processM3U8.toString()}
                    ${hookWorkerFetch.toString()}
                    ${declareOptions.toString()}
                    ${getAccessToken.toString()}
                    ${gqlRequest.toString()}
                    ${parseAttributes.toString()}
                    ${setStreamInfoUrls.toString()}
                    ${onFoundAd.toString()}
                    ${getWasmWorkerJs.toString()}
                    ${getServerTimeFromM3u8.toString()}
                    ${replaceServerTimeInM3u8.toString()}
                    ${getStreamUrlForResolution.toString()}
                    ${updateAdblockBannerForStream.toString()}
                    ${pruneStreamInfos.toString()}
                    ${createStreamInfo.toString()}
                    const workerString = getWasmWorkerJs('${twitchBlobUrl.replaceAll("'", "%27")}');
                    declareOptions(self);
                    if (!self.__tasPruneInterval) {
                        self.__tasPruneInterval = setInterval(pruneStreamInfos, 5 * 60 * 1000);
                    }
                    ReloadPlayerAfterAd = ${ReloadPlayerAfterAd};
                    ReloadCooldownSeconds = ${ReloadCooldownSeconds};
                    EarlyReloadPollThreshold = ${EarlyReloadPollThreshold};
                    PinBackupPlayerType = ${PinBackupPlayerType};
                    OPT_FORCE_ACCESS_TOKEN_PLAYER_TYPE = '${OPT_FORCE_ACCESS_TOKEN_PLAYER_TYPE}';
                    gql_device_id = ${gql_device_id ? "'" + gql_device_id + "'" : null};
                    AuthorizationHeader = ${AuthorizationHeader ? "'" + AuthorizationHeader + "'" : undefined};
                    ClientIntegrityHeader = ${ClientIntegrityHeader ? "'" + ClientIntegrityHeader + "'" : null};
                    self.addEventListener('message', function(e) {
                        if (e.data.key == 'UboUpdateDeviceId') {
                            gql_device_id = e.data.value;
                        } else if (e.data.key == 'UpdateClientIntegrityHeader') {
                            ClientIntegrityHeader = e.data.value;
                        } else if (e.data.key == 'UpdateAuthorizationHeader') {
                            AuthorizationHeader = e.data.value;
                        } else if (e.data.key == 'FetchResponse') {
                            const responseData = e.data.value;
                            if (pendingFetchRequests.has(responseData.id)) {
                                const { resolve, reject, timeoutId } = pendingFetchRequests.get(responseData.id);
                                clearTimeout(timeoutId);
                                pendingFetchRequests.delete(responseData.id);
                                if (responseData.error) {
                                    reject(new Error(responseData.error));
                                } else {
                                    // Create a Response object from the response data.
                                    // Response constructor only takes status/statusText/headers — url/redirected/type
                                    // must be defined on the instance. IVS WASM validates these (Spade/tracking
                                    // requests) and throws NetworkError if they're missing — TTV-AB v6.3.5 fix.
                                    const response = new Response(responseData.body, {
                                        status: responseData.status,
                                        statusText: responseData.statusText,
                                        headers: responseData.headers
                                    });
                                    try {
                                        Object.defineProperty(response, 'url', { value: responseData.url || '', configurable: true });
                                        Object.defineProperty(response, 'redirected', { value: !!responseData.redirected, configurable: true });
                                        Object.defineProperty(response, 'type', { value: responseData.type || 'basic', configurable: true });
                                    } catch {}
                                    resolve(response);
                                }
                            }
                        } else if (e.data.key == 'SimulateAds') {
                            SimulatedAdsDepth = e.data.value;
                            console.log('SimulatedAdsDepth: ' + SimulatedAdsDepth);
                        } else if (e.data.key == 'AllSegmentsAreAdSegments') {
                            AllSegmentsAreAdSegments = !AllSegmentsAreAdSegments;
                            console.log('AllSegmentsAreAdSegments: ' + AllSegmentsAreAdSegments);
                        }
                    });
                    hookWorkerFetch();
                    // Guard the eval — malformed workerString shouldn't silently break
                    // Twitch's player logic without a diagnostic.
                    try { eval(workerString); } catch (e) { console.error('[AD DEBUG] Worker eval failed — Twitch player logic not loaded:', e); }
                `
                if (alreadyHooked) {
                    super(twitchBlobUrl, options);
                    console.log('[AD DEBUG] Worker already hooked — reusing without re-injection');
                } else {
                    console.log('[AD DEBUG] Worker intercepted — injecting ad-block hooks');
                    // Revoke previous blob URL to prevent memory accumulation across worker replacements
                    if (injectedBlobUrl && originalRevokeObjectURL) {
                        try { originalRevokeObjectURL.call(URL, injectedBlobUrl); } catch {}
                    }
                    injectedBlobUrl = URL.createObjectURL(new Blob([newBlobStr]));
                    super(injectedBlobUrl, options);
                }
                twitchWorkers.length = 0;
                twitchWorkers.push(this);
                this.addEventListener('message', (e) => {
                    if (e.data.key === 'TASDiagnostic') recordTASDiagnostic(e.data);
                    if (e.data.key == 'UboUpdateAdBanner') {
                        updateAdblockBanner(e.data);
                    } else if (e.data.key == 'UboReloadPlayer') {
                        reloadTwitchPlayer(false, e.data.kind);
                    } else if (e.data.key == 'UboPauseResumePlayer') {
                        reloadTwitchPlayer(true);
                    }
                });
                this.addEventListener('message', async event => {
                    if (event.data.key == 'FetchRequest') {
                        const fetchRequest = event.data.value;
                        const responseData = await handleWorkerFetchRequest(fetchRequest);
                        this.postMessage({
                            key: 'FetchResponse',
                            value: responseData
                        });
                    }
                });
                // Worker crash recovery — IVS WASM worker can fire RuntimeError
                // (e.g. "index out of bounds") and die. A single crash fires multiple
                // error events; dedupe via a local flag. On first error, trigger a
                // player reload — Twitch re-spawns the worker as part of the new
                // player instance, and existing reload cooldown prevents restart loops.
                let crashed = false;
                this.addEventListener('error', (e) => {
                    if (crashed) return;
                    crashed = true;
                    console.log('[AD DEBUG] IVS WASM worker crashed: ' + ((e && e.message) || 'unknown error') + ' — triggering player reload to recover');
                    try { reloadTwitchPlayer(false); } catch (err) {
                        console.log('[AD DEBUG] Worker crash recovery failed: ' + err.message);
                    }
                });
            }
        }
        let workerInstance = reinsertWorkers(newWorker, reinsert);
        Object.defineProperty(window, 'Worker', {
            get: function() {
                return workerInstance;
            },
            set: function(value) {
                if (isValidWorker(value)) {
                    workerInstance = value;
                } else {
                    console.log('Attempt to set twitch worker denied');
                }
            }
        });
    }
    function getWasmWorkerJs(twitchBlobUrl) {
        if (!getWasmWorkerJs.cache) {
            getWasmWorkerJs.cache = Object.create(null);
        }
        if (getWasmWorkerJs.cache[twitchBlobUrl]) {
            return getWasmWorkerJs.cache[twitchBlobUrl];
        }
        const req = new XMLHttpRequest();
        req.open('GET', twitchBlobUrl, false);
        req.overrideMimeType("text/javascript");
        req.send();
        const text = req.responseText;
        getWasmWorkerJs.cache[twitchBlobUrl] = text;
        return text;
    }
    function setStreamInfoUrls(streamInfo, encodingsM3u8) {
        const lines = encodingsM3u8.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
            // v2 API variant URLs are raw CDN URLs without '.m3u8' in the path.
            // Accept absolute URLs (containing '://') alongside '.m3u8' URLs.
            const trimmed = lines[i]?.trim();
            if (trimmed && !trimmed.startsWith('#') && (trimmed.includes('.m3u8') || trimmed.includes('://'))) {
                StreamInfosByUrl[lines[i].trimEnd()] = streamInfo;
            }
            const nextLine = lines[i + 1]?.trim();
            if (lines[i].startsWith('#EXT-X-STREAM-INF') && nextLine && !nextLine.startsWith('#') && (nextLine.includes('.m3u8') || nextLine.includes('://'))) {
                const attributes = parseAttributes(lines[i]);
                const resolution = attributes['RESOLUTION'];
                if (resolution) {
                    const resolutionInfo = {
                        Resolution: resolution,
                        FrameRate: attributes['FRAME-RATE'],
                        Url: lines[i + 1]
                    };
                    streamInfo.Urls.set(lines[i + 1].trimEnd(), resolutionInfo);
                }
            }
        }
    }
    function updateAdblockBannerForStream(streamInfo) {
        const isShowingAd = !!streamInfo.BackupEncodings;
        if (!isShowingAd && (streamInfo.IsStrippingAdSegments || streamInfo.NumStrippedAdSegments > 0)) {
            streamInfo.IsStrippingAdSegments = false;
            streamInfo.NumStrippedAdSegments = 0;
        }
        postMessage({
            key: 'UboUpdateAdBanner',
            isMidroll: streamInfo.IsMidroll,
            hasAds: isShowingAd,
            isStrippingAdSegments: streamInfo.IsStrippingAdSegments,
            numStrippedAdSegments: streamInfo.NumStrippedAdSegments,
            backupQuality: streamInfo.BackupQuality,
            activeBackupPlayerType: streamInfo.BackupEncodingsPlayerTypeIndex >= 0 ? OPT_BACKUP_PLAYER_TYPES[streamInfo.BackupEncodingsPlayerTypeIndex] : null
        });
    }
    async function onFoundAd(streamInfo, textStr, reloadPlayer, realFetch, url, resolutionInfo) {
        let result = textStr;
        streamInfo.IsMidroll = textStr.includes('"MIDROLL"') || textStr.includes('"midroll"');
        // Track high-confidence ad markers to distinguish real ads from false-positive signifier matches.
        // These attributes are present on every real Twitch ad and absent from anything that could
        // false-positive (e.g. metadata containing the word 'stitched').
        if (!streamInfo.HasConfirmedAdAttrs) {
            streamInfo.HasConfirmedAdAttrs = textStr.includes('X-TV-TWITCH-AD-AD-SESSION-ID') || textStr.includes('X-TV-TWITCH-AD-RADS-TOKEN');
        }
        const playerTypes = [...OPT_BACKUP_PLAYER_TYPES];
        // Try pinned backup player type first if available
        if (PinBackupPlayerType && streamInfo.PinnedBackupPlayerType) {
            const pinnedIndex = playerTypes.indexOf(streamInfo.PinnedBackupPlayerType);
            if (pinnedIndex > 0) {
                playerTypes.splice(pinnedIndex, 1);
                playerTypes.unshift(streamInfo.PinnedBackupPlayerType);
            }
        }
        if (streamInfo.BackupEncodingsStatus.size >= playerTypes.length) {
            return textStr;
        }
        if (streamInfo.BackupEncodings && !streamInfo.BackupEncodings.includes(url)) {
            const streamM3u8Url = getStreamUrlForResolution(streamInfo.BackupEncodings, resolutionInfo);
            const streamM3u8Response = await realFetch(streamM3u8Url);
            if (streamM3u8Response.status === 200) {
                return await streamM3u8Response.text();
            }
        }
        const backupSearchStart = Date.now();
        let backupPlayerTypeInfo = '';
        for (let i = 0; i < playerTypes.length; i++) {
            const playerType = playerTypes[i];
            if (!streamInfo.BackupEncodingsStatus.has(playerType)) {
                try {
                    postMessage({ key: 'TASDiagnostic', event: 'backup-attempt', playerType });
                    const accessTokenResponse = await getAccessToken(streamInfo.ChannelName, playerType);
                    if (accessTokenResponse != null && accessTokenResponse.status !== 200) {
                        let errorBody = '';
                        try { errorBody = ' — ' + (await accessTokenResponse.text()).substring(0, 200); } catch {}
                        console.log('[AD DEBUG] Access token HTTP ' + accessTokenResponse.status + ' for ' + playerType + (accessTokenResponse.status === 403 ? ' (integrity: ' + (ClientIntegrityHeader ? 'present' : 'missing') + ')' : '') + errorBody);
                        streamInfo.ConsecutiveTokenFetchFailures = (streamInfo.ConsecutiveTokenFetchFailures || 0) + 1;
                        if (streamInfo.ConsecutiveTokenFetchFailures >= 3 && !streamInfo.LoggedTokenFailureStreak) {
                            streamInfo.LoggedTokenFailureStreak = true;
                            console.log('[AD DEBUG] Token fetch failed ' + streamInfo.ConsecutiveTokenFetchFailures + ' times consecutively across player types — possible Twitch detection / integrity rotation / rate limiting');
                        }
                    }
                    if (accessTokenResponse != null && accessTokenResponse.status === 200) {
                        const accessToken = await accessTokenResponse.json();
                        // Twitch returns streamPlaybackAccessToken in two observed shapes:
                        //   { data: { streamPlaybackAccessToken: {...} } } (most player types)
                        //   { streamPlaybackAccessToken: {...} } (flatter, observed for 'embed')
                        // Accept either. Field-observed silently dropping embed backup otherwise.
                        const spat = accessToken?.data?.streamPlaybackAccessToken || accessToken?.streamPlaybackAccessToken;
                        if (!spat) {
                            const errInfo = accessToken?.errors ? ' errors: ' + JSON.stringify(accessToken.errors).substring(0, 300) : '';
                            console.log('[AD DEBUG] GQL response missing streamPlaybackAccessToken for ' + playerType + '. Response keys: ' + JSON.stringify(Object.keys(accessToken || {})) + errInfo);
                            streamInfo.ConsecutiveTokenFetchFailures = (streamInfo.ConsecutiveTokenFetchFailures || 0) + 1;
                            if (streamInfo.ConsecutiveTokenFetchFailures >= 3 && !streamInfo.LoggedTokenFailureStreak) {
                                streamInfo.LoggedTokenFailureStreak = true;
                                console.log('[AD DEBUG] Token fetch failed ' + streamInfo.ConsecutiveTokenFetchFailures + ' times consecutively across player types — possible Twitch detection / integrity rotation / rate limiting');
                            }
                            continue;
                        }
                        const urlInfo = new URL('https://usher.ttvnw.net/api/' + (V2API ? 'v2/' : '') + 'channel/hls/' + streamInfo.ChannelName + '.m3u8' + streamInfo.UsherParams);
                        urlInfo.searchParams.set('sig', spat.signature);
                        urlInfo.searchParams.set('token', spat.value);
                        const encodingsM3u8Response = await realFetch(urlInfo.href);
                        if (encodingsM3u8Response != null && encodingsM3u8Response.status !== 200) {
                            console.log('[AD DEBUG] Usher HTTP ' + encodingsM3u8Response.status + ' for ' + playerType);
                        }
                        if (encodingsM3u8Response != null && encodingsM3u8Response.status === 200) {
                            streamInfo.ConsecutiveTokenFetchFailures = 0;
                            streamInfo.LoggedTokenFailureStreak = false;
                            let encodingsM3u8 = resolvePlaylistUrls(await encodingsM3u8Response.text(), encodingsM3u8Response.url || urlInfo.href);
                            const streamM3u8Url = getStreamUrlForResolution(encodingsM3u8, resolutionInfo);
                            const streamM3u8Response = await realFetch(streamM3u8Url);
                            if (streamM3u8Response.status === 200) {
                                const backTextStr = resolvePlaylistUrls(await streamM3u8Response.text(), streamM3u8Response.url || streamM3u8Url);
                                if ((!hasAdTags(backTextStr) && (SimulatedAdsDepth == 0 || i >= SimulatedAdsDepth - 1)) || i >= playerTypes.length - 1) {
                                    result = backTextStr;
                                    backupPlayerTypeInfo = ' (' + playerType + ')';
                                    streamInfo.BackupEncodingsStatus.set(playerType, 1);
                                    streamInfo.BackupEncodingsPlayerTypeIndex = i;
                                    if (PinBackupPlayerType) {
                                        streamInfo.PinnedBackupPlayerType = playerType;
                                    }
                                    if (streamInfo.Encodings != null) {
                                        // Low resolution streams will reduce the number of resolutions in the UI. To fix this we merge the low res URLs into the main m3u8
                                        const normalEncodingsM3u8 = streamInfo.Encodings;
                                        const normalLines = normalEncodingsM3u8.split(/\r?\n/);
                                        for (let j = 0; j < normalLines.length - 1; j++) {
                                            if (normalLines[j].startsWith('#EXT-X-STREAM-INF')) {
                                                const resSettings = parseAttributes(normalLines[j].substring(normalLines[j].indexOf(':') + 1));
                                                const lowResUrl = getStreamUrlForResolution(encodingsM3u8, streamInfo.Urls.get(normalLines[j + 1].trimEnd()));
                                                const lowResInf = encodingsM3u8.match(new RegExp(`^.*(?=\n.*${lowResUrl})`, 'm'))?.[0];
                                                if (!lowResInf) continue;
                                                const lowResSettings = parseAttributes(lowResInf.substring(lowResInf.indexOf(':') + 1));
                                                const codecsKey = 'CODECS';
                                                if (typeof resSettings[codecsKey] === 'string' && typeof lowResSettings[codecsKey] === 'string' &&
                                                    resSettings[codecsKey].length >= 3 && lowResSettings[codecsKey].length >= 3 &&
                                                    (resSettings[codecsKey].startsWith('hev') || resSettings[codecsKey].startsWith('hvc')) &&
                                                    resSettings[codecsKey].substring(0, 3) !== lowResSettings[codecsKey].substring(0, 3)
                                                ) {
                                                    console.log('swap ' + resSettings[codecsKey] + ' to ' + lowResSettings[codecsKey]);
                                                    normalLines[j] = normalLines[j].replace(/CODECS="[^"]+"/, `CODECS="${lowResSettings[codecsKey]}"`);
                                                    console.log(normalLines[j]);
                                                }
                                                normalLines[j + 1] = lowResUrl + ' '.repeat(j + 1);// The stream doesn't load unless each url line is unique
                                            }
                                        }
                                        encodingsM3u8 = normalLines.join('\n');
                                    }
                                    streamInfo.BackupEncodings = encodingsM3u8;
                                    const backupLines = encodingsM3u8.split(/\r?\n/);
                                    const backupQuality = parseAttributes(backupLines[backupLines.indexOf(streamM3u8Url) - 1]).RESOLUTION || 'unknown';
                                    streamInfo.BackupQuality = backupQuality;
                                    postMessage({ key: 'TASDiagnostic', event: 'backup-selected', playerType, quality: backupQuality, durationMs: Date.now() - backupSearchStart });
                                    setStreamInfoUrls(streamInfo, encodingsM3u8);
                                }
                            }
                        }
                    }
                } catch (err) { console.error(err); }
                if (streamInfo.BackupEncodingsStatus.get(playerType) === 1) {
                    break;
                } else {
                    streamInfo.BackupEncodingsStatus.set(playerType, 0);
                }
            }
        }
        console.log('Found ads, switch to backup' + backupPlayerTypeInfo + ' in ' + (Date.now() - backupSearchStart) + 'ms — signifiers: ' + getMatchedAdSignifiers(textStr).join(', '));
        if (reloadPlayer) {
            postMessage({key: ReloadPlayerAfterAd ? 'UboReloadPlayer' : 'UboPauseResumePlayer'});
        }
        updateAdblockBannerForStream(streamInfo);
        return result;
    }
    function hasAdTags(textStr) {
        return AD_SIGNIFIERS.some((s) => s && textStr.includes(s));
    }
    function getMatchedAdSignifiers(textStr) {
        return AD_SIGNIFIERS.filter((s) => textStr.includes(s));
    }
    function stripAdSegments(textStr, stripAllSegments, streamInfo) {
        let hasStrippedAdSegments = false;
        let inCueOut = false;
        const liveSegments = [];
        let segmentNumber = -1;
        const lines = textStr.split(/\r?\n/);
        const newAdUrl = 'https://twitch.tv';
        // Log ad tracking attribute names once per stream (helps identify new beacons)
        if (!streamInfo.HasLoggedAdAttributes) {
            const adAttrs = textStr.match(/X-TV-TWITCH-AD[A-Z-]*(?==")/g);
            if (adAttrs && adAttrs.length > 0) {
                streamInfo.HasLoggedAdAttributes = true;
                console.log('[AD DEBUG] Ad tracking attributes seen: ' + [...new Set(adAttrs)].join(', '));
            }
        }
        // Log potential ad markers that aren't in AD_SIGNIFIERS (candidates for future inclusion)
        if (!streamInfo.HasLoggedUnknownSignifiers) {
            const candidates = new Set();
            let sm;
            const classRe = /EXT-X-DATERANGE:[^\n]*CLASS="(twitch-[^"]+)"/g;
            while ((sm = classRe.exec(textStr)) !== null) {
                candidates.add('EXT-X-DATERANGE:CLASS="' + sm[1] + '"');
            }
            const tagRe = /(SCTE35-[A-Z-]+|EXT-X-CUE-[A-Z-]+)/g;
            while ((sm = tagRe.exec(textStr)) !== null) {
                candidates.add(sm[1]);
            }
            // Substring check (not exact): a candidate is "known" if any AD_SIGNIFIER
            // appears within it. This handles prefix signifiers like 'twitch-stitched'
            // covering 'EXT-X-DATERANGE:CLASS="twitch-stitched-ad"' etc.
            const unknown = [...candidates].filter(c =>
                !AD_SIGNIFIERS.some(s => s && c.includes(s)) &&
                !KNOWN_NON_AD_SIGNIFIERS.some(s => s && c.includes(s))
            );
            if (unknown.length > 0) {
                streamInfo.HasLoggedUnknownSignifiers = true;
                console.log('[AD DEBUG] Potential ad markers seen but not in AD_SIGNIFIERS: ' + unknown.join(', ') + ' (candidates for future inclusion)');
            }
        }
        for (let i = 0; i < lines.length; i++) {
            let line = lines[i];
            if (line.startsWith('#EXTINF')) segmentNumber++;
            // Track SCTE-35 CUE-OUT/CUE-IN ad boundaries
            if (line.includes('EXT-X-CUE-OUT')) {
                if (!inCueOut) {
                    console.log('[AD DEBUG] SCTE-35 CUE-OUT — ad boundary entered');
                }
                inCueOut = true;
            } else if (line.includes('EXT-X-CUE-IN')) {
                if (inCueOut) {
                    console.log('[AD DEBUG] SCTE-35 CUE-IN — ad boundary exited');
                }
                inCueOut = false;
            }
            // Remove tracking urls which appear in the overlay UI
            lines[i] = line.replaceAll(TWITCH_AD_URL_REWRITE_REGEX, `$1${newAdUrl}$2`);
            if (i < lines.length - 1 && line.startsWith('#EXTINF') && (!line.includes(',live') || stripAllSegments || AllSegmentsAreAdSegments || inCueOut)) {
                const segmentUrl = lines[i + 1];
                if (!AdSegmentCache.has(segmentUrl)) {
                    streamInfo.NumStrippedAdSegments++;
                }
                AdSegmentCache.set(segmentUrl, Date.now());
                hasStrippedAdSegments = true;
            } else if (i < lines.length - 1 && line.startsWith('#EXTINF') && AD_SEGMENT_URL_PATTERNS.some((p) => lines[i + 1].includes(p))) {
                console.log('[AD DEBUG] Ad segment detected via URL pattern: ' + lines[i + 1]);
                AdSegmentCache.set(lines[i + 1], Date.now());
                hasStrippedAdSegments = true;
                streamInfo.NumStrippedAdSegments++;
            } else if (i < lines.length - 1 && line.startsWith('#EXTINF') && line.includes(',live')) {
                liveSegments.push({ extinf: line, url: lines[i + 1], number: segmentNumber, index: i });
            } else if (line.startsWith('#EXT-X-PART:')) {
                // LL-HLS part: URI is inline as an attribute. Strip if it matches a known
                // ad URL (already in cache from a parallel EXTINF strip, or matches a URL pattern).
                // Without this, the player may use the parts path to fetch ad media via low-latency.
                const partUriMatch = line.match(URI_ATTRIBUTE_REGEX);
                const partUri = partUriMatch ? partUriMatch[1] : '';
                if (partUri && (AdSegmentCache.has(partUri) || AD_SEGMENT_URL_PATTERNS.some((p) => partUri.includes(p)))) {
                    AdSegmentCache.set(partUri, Date.now());
                    lines[i] = '';
                    hasStrippedAdSegments = true;
                }
            } else if (line.startsWith('#EXT-X-TWITCH-PREFETCH:') || line.startsWith('#EXT-X-PRELOAD-HINT:')) {
                // LL-HLS prefetch/preload hints can point at upcoming ad segments before any
                // EXTINF line or ad signifier has materialized in the playlist. If we only
                // strip prefetch hints AFTER hasStrippedAdSegments is set, the first poll of
                // an ad break can leak a prefetch hint pointing at an ad URL — the player
                // then pre-fetches ad media via the LL-HLS path before our usual strip catches
                // up, producing an ad flash. Detect the ad URL here so hasStrippedAdSegments
                // flips on the first poll and the post-loop unconditional prefetch strip fires.
                // Ported from TTV-AB 52b41b4.
                let hintUrl = '';
                if (line.startsWith('#EXT-X-TWITCH-PREFETCH:')) {
                    hintUrl = line.substring('#EXT-X-TWITCH-PREFETCH:'.length).trim();
                } else {
                    const hintMatch = line.match(/URI="([^"]+)"/);
                    hintUrl = hintMatch ? hintMatch[1] : '';
                }
                if (hintUrl && (AdSegmentCache.has(hintUrl) || AD_SEGMENT_URL_PATTERNS.some((p) => hintUrl.includes(p)))) {
                    AdSegmentCache.set(hintUrl, Date.now());
                    hasStrippedAdSegments = true;
                }
            }
        }
        // Moved out of the per-line loop: a per-line scan for any signifier is
        // semantically equivalent to a single full-text scan, since the check has
        // no line-level state — it just flips hasStrippedAdSegments = true on first
        // match. One scan instead of N_lines * N_signifiers scans (~100x fewer
        // includes() calls on a typical 100-line m3u8).
        if (!hasStrippedAdSegments && hasAdTags(textStr)) {
            hasStrippedAdSegments = true;
        }
        if (hasStrippedAdSegments) {
            for (let i = 0; i < lines.length; i++) {
                // No low latency during ads (otherwise it's possible for the player to prefetch and display ad segments)
                if (lines[i].startsWith('#EXT-X-TWITCH-PREFETCH:') || lines[i].startsWith('#EXT-X-PRELOAD-HINT:')) {
                    lines[i] = '';
                }
            }
        } else {
            streamInfo.NumStrippedAdSegments = 0;
        }
        // Keep a contiguous run: removed ads still occupy sequence numbers in the source.
        if (liveSegments.length > 0) {
            let first = liveSegments.length - 1;
            while (first > 0 && liveSegments[first].number === liveSegments[first - 1].number + 1) first--;
            streamInfo.RecoverySegments = liveSegments.slice(Math.max(first, liveSegments.length - 6));
            const start = streamInfo.RecoverySegments[0];
            const end = streamInfo.RecoverySegments[streamInfo.RecoverySegments.length - 1];
            const seq = Number((textStr.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/) || [])[1] || 0);
            streamInfo.RecoveryStartSeq = seq + start.number;
            // Cache the original metadata too. A later ad playlist can use different
            // encryption keys, init maps and discontinuity counters than this content.
            let bodyStart = start.index;
            while (bodyStart > 0 && (lines[bodyStart - 1].startsWith('#') || !lines[bodyStart - 1].trim())) bodyStart--;
            const before = lines.slice(0, bodyStart);
            const headers = lines.filter(line => /^#EXTM3U$|^#EXT-X-(?:VERSION|TARGETDURATION|INDEPENDENT-SEGMENTS)(?::|$)/.test(line));
            const discontinuitySeq = Number((textStr.match(/#EXT-X-DISCONTINUITY-SEQUENCE:(\d+)/) || [])[1] || 0)
                + before.filter(line => line === '#EXT-X-DISCONTINUITY').length;
            headers.push('#EXT-X-MEDIA-SEQUENCE:' + streamInfo.RecoveryStartSeq, '#EXT-X-DISCONTINUITY-SEQUENCE:' + discontinuitySeq);
            for (const tag of ['#EXT-X-KEY:', '#EXT-X-MAP:']) {
                const active = lines.slice(0, start.index).filter(line => line.startsWith(tag)).pop();
                if (active) headers.push(active);
            }
            const body = lines.slice(bodyStart, end.index + 2).filter(line =>
                (line.trim() && !line.startsWith('#')) || /^#EXTINF:|^#EXT-X-(?:KEY|MAP|PROGRAM-DATE-TIME|BYTERANGE|DISCONTINUITY|GAP)(?::|$)/.test(line));
            streamInfo.RecoveryM3U8 = [...headers, ...body].join('\n');
        }
        // If all segments were stripped, try to prevent black screen via recovery content.
        // Prefer the full-playlist snapshot from a recent non-ad poll (mirrors TTV-AB
        // LastCleanNativeM3U8 approach) — gives the player 4-6 live segments worth of
        // content vs the thin per-segment recovery cache. Falls back to the per-segment
        // cache if the snapshot is stale or missing.
        if (hasStrippedAdSegments && liveSegments.length === 0) {
            streamInfo.ConsecutiveAllStrippedPolls = (streamInfo.ConsecutiveAllStrippedPolls || 0) + 1;
            const recoveryThin = (streamInfo.RecoverySegments?.length || 0) < 3;
            const effectiveThreshold = recoveryThin ? 1 : EarlyReloadPollThreshold;
            if (EarlyReloadPollThreshold > 0 && streamInfo.ConsecutiveAllStrippedPolls >= effectiveThreshold && !streamInfo.EarlyReloadTriggered) {
                streamInfo.EarlyReloadTriggered = true;
                const reason = recoveryThin ? ' (thin recovery cache: ' + (streamInfo.RecoverySegments?.length || 0) + ' segments)' : '';
                console.log('[AD DEBUG] Early reload triggered — ' + streamInfo.ConsecutiveAllStrippedPolls + ' consecutive all-stripped polls' + reason);
                // kind: 'early' bypasses the cooldown gate that's meant for buffer-monitor reloads.
                postMessage({ key: 'UboReloadPlayer', kind: 'early' });
            }
            // Primary: fresh full-playlist snapshot (< 1.5s old, must not itself contain ad markers)
            const snapshotAge = streamInfo.LastCleanNativePlaylistAt ? (Date.now() - streamInfo.LastCleanNativePlaylistAt) : Infinity;
            if (streamInfo.LastCleanNativeM3U8 && snapshotAge <= 1500 && !hasAdTags(streamInfo.LastCleanNativeM3U8)) {
                console.log('[AD DEBUG] All segments stripped — reusing last clean native playlist (' + snapshotAge + 'ms old)');
                streamInfo.IsStrippingAdSegments = hasStrippedAdSegments;
                return streamInfo.LastCleanNativeM3U8;
            }
            // Fallback: per-segment recovery cache (existing behavior)
            if (streamInfo.RecoverySegments && streamInfo.RecoverySegments.length > 0) {
                console.log('[AD DEBUG] All segments stripped — restoring ' + streamInfo.RecoverySegments.length + ' recovery segments');
                // Replace the ad media section instead of appending cached content after it.
                // Otherwise each retained ad entry shifts the cached segment's sequence number.
                const recovery = streamInfo.RecoveryM3U8 || [
                    ...lines.filter(line => /^#EXTM3U$|^#EXT-X-(?:VERSION|TARGETDURATION)(?::|$)/.test(line)),
                    '#EXT-X-MEDIA-SEQUENCE:' + (streamInfo.RecoveryStartSeq || 0),
                    ...streamInfo.RecoverySegments.flatMap(segment => [segment.extinf, segment.url])
                ].join('\n');
                lines.splice(0, lines.length, ...recovery.split('\n'));
            }
        }
        streamInfo.IsStrippingAdSegments = hasStrippedAdSegments;
        const now = Date.now();
        // Throttle cache prune to once per 60s. The 120s TTL gives plenty of headroom
        // and scanning the full cache on every m3u8 poll adds up during heavy ad break
        // sequences (LL-HLS can poll multiple times per second). Ported from TTV-AB.
        if (!streamInfo.LastAdCachePruneAt || now - streamInfo.LastAdCachePruneAt > 60000) {
            streamInfo.LastAdCachePruneAt = now;
            AdSegmentCache.forEach((value, key, map) => {
                if (value < now - 120000) {
                    map.delete(key);
                }
            });
            // Diagnostic: log once per streamInfo when the cache crosses 1000 entries,
            // so cache bloat from a future TTL/prune bug would surface in user reports
            // instead of staying invisible.
            if (AdSegmentCache.size > 1000 && !streamInfo.LoggedAdCacheSize1k) {
                streamInfo.LoggedAdCacheSize1k = true;
                console.log('[AD DEBUG] AdSegmentCache crossed 1000 entries (now ' + AdSegmentCache.size + ') — possible cache bloat');
            }
        }
        return lines.join('\n');
    }
    async function processM3U8(url, textStr, realFetch) {
        const streamInfo = StreamInfosByUrl[url];
        if (!streamInfo) {
            return textStr;
        }
        streamInfo.LastSeenAt = Date.now();
        if (!streamInfo.LoggedOfflineTransition && textStr.includes('#EXT-X-ENDLIST') && !textStr.includes('#EXTINF:')) {
            streamInfo.LoggedOfflineTransition = true;
            console.log('[AD DEBUG] Stream ended / offline shape detected — m3u8 has #EXT-X-ENDLIST with no segments. Possible Twitch detection response, broadcaster ended stream, or natural end-of-broadcast');
        }
        const currentResolution = streamInfo.Urls.get(url);
        if (!currentResolution) {
            return textStr;
        }
        if (!streamInfo.HasCheckedUnknownTags) {
            streamInfo.HasCheckedUnknownTags = true;
            const unknownAdTags = textStr.match(/#EXT[^:\n]*(?:ad|cue|scte|sponsor)[^:\n]*/gi);
            if (unknownAdTags) {
                const unknown = unknownAdTags.filter(t => !AD_SIGNIFIERS.some(s => s && t.includes(s)));
                if (unknown.length > 0) {
                    console.log('[AD DEBUG] Unknown ad-related tags found: ' + [...new Set(unknown)].join(', '));
                }
            }
        }
        const haveAdTags = hasAdTags(textStr) || (SimulatedAdsDepth > 0 && (!streamInfo.BackupEncodings || !streamInfo.BackupEncodings.includes(url) || SimulatedAdsDepth - 1 > streamInfo.BackupEncodingsPlayerTypeIndex));
        // Cache the clean main stream m3u8 for all-stripped recovery fallback.
        // Updated during non-ad polls (outside of any ad break), so by the time an ad
        // break starts, streamInfo.LastCleanNativeM3U8 holds a snapshot ~1-2 seconds old
        // with several live segments. When heavy SSAI breaks leave the main playlist
        // entirely stripped, stripAdSegments replays this snapshot instead of the thin
        // RecoverySegments array — typically gives the player 4-6 live segments of
        // content vs the 1-2 cached individual segments.
        // Mirrors TTV-AB src/modules/processor.ts:733-736.
        if (!haveAdTags && !streamInfo.BackupEncodings && textStr.indexOf('#EXTINF') !== -1) {
            streamInfo.LastCleanNativeM3U8 = textStr;
            streamInfo.LastCleanNativePlaylistAt = Date.now();
        }
        if (streamInfo.BackupEncodings) {
            const streamM3u8Url = streamInfo.Encodings.match(/^https:.*\.m3u8$/m)?.[0];
            const streamM3u8Response = await realFetch(streamM3u8Url);
            if (streamM3u8Response.status == 200) {
                const streamM3u8 = resolvePlaylistUrls(await streamM3u8Response.text(), streamM3u8Response.url || streamM3u8Url);
                if (streamM3u8 != null) {
                    if (!hasAdTags(streamM3u8) && SimulatedAdsDepth == 0) {
                        // Mirrors TTV-AB v6.6.7 #1: mark first candidate-end timestamp on the first
                        // clean main-stream poll, so the slow-path max-wait gate below can fire even
                        // if subsequent polls bounce back to ad-marked.
                        if (!streamInfo.PendingAdEndAt) {
                            streamInfo.PendingAdEndAt = Date.now();
                        }
                        streamInfo.CleanPlaylistCount++;
                        // Check if the current playlist has live segments — if not, backup stream is dead
                        const hasLiveSegments = textStr.includes(LIVE_SIGNIFIER);
                        // Mirrors TTV-AB v6.6.7 #4: independent slow-path max-wait escalation gate so
                        // bouncing markers can't wedge the player on backup indefinitely.
                        const adEndMaxWaitMs = 12000;
                        const elapsedSinceCandidate = Date.now() - streamInfo.PendingAdEndAt;
                        const slowPathReady = streamInfo.PendingAdEndAt > 0 && elapsedSinceCandidate >= adEndMaxWaitMs;
                        if (streamInfo.CleanPlaylistCount >= 2 || !hasLiveSegments || slowPathReady) {
                            if (slowPathReady && streamInfo.CleanPlaylistCount < 2) {
                                console.log('[AD DEBUG] Slow-path ad-end escalation — ' + (streamInfo.AdEndBounceCount || 0) + ' marker bounces, ' + (elapsedSinceCandidate / 1000).toFixed(1) + 's since first clean poll');
                            }
                            if (!hasLiveSegments) {
                                console.log('[AD DEBUG] Backup stream has no live segments — forcing immediate reload');
                            }
                            console.log('No more ads on main stream. Stripped ' + streamInfo.NumStrippedAdSegments + ' ad segments. ' + (ReloadPlayerAfterAd ? 'Triggering player reload to go back to main stream...' : 'Resuming playback...'));
                            // Only count toward false-positive guard if the m3u8 lacked high-confidence ad markers.
                            // Confirmed ads (with X-TV-TWITCH-AD-AD-SESSION-ID etc.) that produce 0 strips are real
                            // ads we successfully avoided via clean backup — not false positives.
                            if (streamInfo.NumStrippedAdSegments === 0 && !streamInfo.HasConfirmedAdAttrs) {
                                streamInfo.ConsecutiveZeroStripBreaks++;
                                if (streamInfo.ConsecutiveZeroStripBreaks >= 3) {
                                    console.log('[AD DEBUG] Warning: ' + streamInfo.ConsecutiveZeroStripBreaks + ' consecutive unconfirmed ad breaks with 0 segments stripped — possible false positive from ad signifiers');
                                }
                            } else if (streamInfo.NumStrippedAdSegments > 0) {
                                streamInfo.ConsecutiveZeroStripBreaks = 0;
                            }
                            streamInfo.HasConfirmedAdAttrs = false;
                            streamInfo.HasLoggedCsaiFastPath = false;
                            streamInfo.HasLoggedCsaiToSsaiTransition = false;
                            streamInfo.HasLoggedAdAttributes = false;
                            streamInfo.HasLoggedUnknownSignifiers = false;
                            streamInfo.RequestedAds?.clear?.();
                            streamInfo.ConsecutiveAllStrippedPolls = 0;
                            streamInfo.EarlyReloadTriggered = false;
                            streamInfo.IsMovingOffBackupEncodings = true;
                            streamInfo.BackupEncodings = null;
                            streamInfo.BackupEncodingsStatus?.clear?.();
                            streamInfo.BackupEncodingsPlayerTypeIndex = -1;
                            streamInfo.CleanPlaylistCount = 0;
                            streamInfo.PendingAdEndAt = 0;
                            streamInfo.AdEndBounceCount = 0;
                            postMessage({key: ReloadPlayerAfterAd ? 'UboReloadPlayer' : 'UboPauseResumePlayer'});
                        }
                    } else {
                        // Mirrors TTV-AB v6.6.7 #1: bounce-tolerant reset keeps PendingAdEndAt alive
                        // across short flips back to ad-marked, so the slow-path max-wait gate can
                        // still fire when bouncing markers prevent CleanPlaylistCount progress.
                        const adEndStalenessMs = 12000;
                        if (streamInfo.PendingAdEndAt && (Date.now() - streamInfo.PendingAdEndAt) < adEndStalenessMs) {
                            streamInfo.AdEndBounceCount = (streamInfo.AdEndBounceCount || 0) + 1;
                        } else {
                            streamInfo.PendingAdEndAt = 0;
                            streamInfo.AdEndBounceCount = 0;
                        }
                        streamInfo.CleanPlaylistCount = 0;
                        if (!streamM3u8.includes('"MIDROLL"') && !streamM3u8.includes('"midroll"')) {
                            const lines = streamM3u8.split(/\r?\n/);
                            for (let i = 0; i < lines.length; i++) {
                                const line = lines[i];
                                if (line.startsWith('#EXTINF') && lines.length > i + 1) {
                                    if (!line.includes(LIVE_SIGNIFIER) && !streamInfo.RequestedAds.has(lines[i + 1])) {
                                        // Only request one .ts file per .m3u8 request to avoid making too many requests
                                        streamInfo.RequestedAds.add(lines[i + 1]);
                                        fetch(lines[i + 1]).then((response) => response.blob()).catch(() => {});
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }
            }
            if (streamInfo.BackupEncodings && haveAdTags) {
                textStr = await onFoundAd(streamInfo, textStr, true, realFetch, url, currentResolution);
            }
        } else if (haveAdTags && !streamInfo.IsMovingOffBackupEncodings) {
            // CSAI fast path: if all segments in the main stream are live, skip backup search.
            // CSAI ads are delivered outside the m3u8 — the main stream segments are clean.
            // Return the main stream directly, avoiding the backup stream switch that causes
            // a 20-40s rebuffer gap.
            const mainStreamLines = textStr.split(/\r?\n/);
            let hasNonLiveSegment = false;
            for (let i = 0; i < mainStreamLines.length; i++) {
                if (mainStreamLines[i].startsWith('#EXTINF') && !mainStreamLines[i].includes(LIVE_SIGNIFIER)) {
                    hasNonLiveSegment = true;
                    break;
                }
            }
            if (!hasNonLiveSegment) {
                if (!streamInfo.HasLoggedCsaiFastPath) {
                    streamInfo.HasLoggedCsaiFastPath = true;
                    // Reworded — the original "all segments live, skipping backup search"
                    // implied a permanent state, but it only describes this poll. Twitch can
                    // shift mid-break to SSAI (stitched ad segments) at which point the
                    // backup search legitimately fires; the transition is logged separately.
                    console.log('[AD DEBUG] CSAI fast path — current poll has all-live segments, skipping backup search this poll (playlist may shift to SSAI on subsequent polls)');
                }
            } else {
                if (streamInfo.HasLoggedCsaiFastPath && !streamInfo.HasLoggedCsaiToSsaiTransition) {
                    streamInfo.HasLoggedCsaiToSsaiTransition = true;
                    console.log('[AD DEBUG] Playlist now contains stitched ad segments — CSAI fast path no longer applies, falling through to backup search');
                }
                textStr = await onFoundAd(streamInfo, textStr, true, realFetch, url, currentResolution);
            }
        }
        if (IsAdStrippingEnabled) {
            textStr = stripAdSegments(textStr, false, streamInfo);
        }
        updateAdblockBannerForStream(streamInfo);
        return textStr;
    }
    // Resolve against the fetched playlist, including redirects and inline HLS URIs.
    function resolvePlaylistUrls(textStr, playlistUrl) {
        const resolve = uri => {
            try { return new URL(uri, playlistUrl).href; } catch { return uri; }
        };
        return textStr.split(/\r?\n/).map(line => {
            if (!line.startsWith('#')) return line.trim() ? resolve(line.trim()) : line;
            const prefetch = '#EXT-X-TWITCH-PREFETCH:';
            if (line.startsWith(prefetch)) return prefetch + resolve(line.slice(prefetch.length).trim());
            return line.replace(/([,:])URI="([^"]+)"/g, (_, prefix, uri) => prefix + 'URI="' + resolve(uri) + '"');
        }).join('\n');
    }
    function hookWorkerFetch() {
        console.log('[AD DEBUG] hookWorkerFetch (video-swap-new)');
        const realFetch = fetch;
        fetch = async function(url, options) {
            if (typeof url === 'string') {
                if (AdSegmentCache.has(url)) {
                    return new Promise(function(resolve, reject) {
                        realFetch('data:video/mp4;base64,AAAAKGZ0eXBtcDQyAAAAAWlzb21tcDQyZGFzaGF2YzFpc282aGxzZgAABEltb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAYagAAAAAAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAAABqHRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAURtZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAALuAAAAAAFXEAAAAAAAtaGRscgAAAAAAAAAAc291bgAAAAAAAAAAAAAAAFNvdW5kSGFuZGxlcgAAAADvbWluZgAAABBzbWhkAAAAAAAAAAAAAAAkZGluZgAAABxkcmVmAAAAAAAAAAEAAAAMdXJsIAAAAAEAAACzc3RibAAAAGdzdHNkAAAAAAAAAAEAAABXbXA0YQAAAAAAAAABAAAAAAAAAAAAAgAQAAAAALuAAAAAAAAzZXNkcwAAAAADgICAIgABAASAgIAUQBUAAAAAAAAAAAAAAAWAgIACEZAGgICAAQIAAAAQc3R0cwAAAAAAAAAAAAAAEHN0c2MAAAAAAAAAAAAAABRzdHN6AAAAAAAAAAAAAAAAAAAAEHN0Y28AAAAAAAAAAAAAAeV0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAoAAAAFoAAAAAAGBbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAA9CQAAAAABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABLG1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAOxzdGJsAAAAoHN0c2QAAAAAAAAAAQAAAJBhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAoABaABIAAAASAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGP//AAAAOmF2Y0MBTUAe/+EAI2dNQB6WUoFAX/LgLUBAQFAAAD6AAA6mDgAAHoQAA9CW7y4KAQAEaOuPIAAAABBzdHRzAAAAAAAAAAAAAAAQc3RzYwAAAAAAAAAAAAAAFHN0c3oAAAAAAAAAAAAAAAAAAAAQc3RjbwAAAAAAAAAAAAAASG12ZXgAAAAgdHJleAAAAAAAAAABAAAAAQAAAC4AAAAAAoAAAAAAACB0cmV4AAAAAAAAAAIAAAABAACCNQAAAAACQAAA', options).then(function(response) {
                            resolve(response);
                        })['catch'](function(err) {
                            reject(err);
                        });
                    });
                }
                url = url.trimEnd();
                let parsedRequestUrl;
                try { parsedRequestUrl = new URL(url); } catch { return realFetch(url, options); }
                if (!parsedRequestUrl.pathname.includes('/channel/hls/') && (StreamInfosByUrl[url] || parsedRequestUrl.pathname.endsWith('.m3u8'))) {
                    return new Promise(function(resolve, reject) {
                        const processAfter = async function(response) {
                            if (response.status === 200) {
                                const str = await processM3U8(url, resolvePlaylistUrls(await response.text(), response.url || url), realFetch);
                                resolve(new Response(str, {
                                    status: response.status,
                                    statusText: response.statusText,
                                    headers: response.headers
                                }));
                            } else {
                                resolve(response);
                            }
                        };
                        realFetch(url, options).then(function(response) {
                            return processAfter(response);
                        })['catch'](function(err) {
                            const errMsg = String(err?.message || err);
                            if (err?.name !== 'AbortError' && !/cancel|abort/i.test(errMsg)) console.log('fetch hook err ' + err);
                            reject(err);
                        });
                    });
                }
                else if (url.includes('/channel/hls/') && !url.includes('picture-by-picture')) {
                    V2API = url.includes('/api/v2/');
                    const channelName = (new URL(url)).pathname.match(/([^\/]+)(?=\.\w+$)/)?.[0];
                    if (OPT_FORCE_ACCESS_TOKEN_PLAYER_TYPE) {
                        // parent_domains is used to determine if the player is embeded and stripping it gets rid of fake ads
                        const tempUrl = new URL(url);
                        tempUrl.searchParams.delete('parent_domains');
                        url = tempUrl.toString();
                    }
                    // - First m3u8 request is the m3u8 with the video encodings (360p,480p,720p,etc).
                    // - Second m3u8 request is the m3u8 for the given encoding obtained in the first request. At this point we will know if there's ads.
                    let streamInfo = StreamInfos[channelName];
                    if (streamInfo != null && streamInfo.Encodings != null && (await realFetch(streamInfo.Encodings.match(/^https:.*\.m3u8$/m)?.[0])).status !== 200) {
                        // The cached encodings are dead (the stream probably restarted)
                        streamInfo = null;
                    }
                    let serverTime = null;
                    if (streamInfo == null || streamInfo.Encodings == null) {
                        StreamInfos[channelName] = streamInfo = createStreamInfo(channelName, (new URL(url)).search);
                        const encodingsM3u8Response = await realFetch(url, options);
                        if (encodingsM3u8Response != null && encodingsM3u8Response.status === 200) {
                            const encodingsM3u8 = resolvePlaylistUrls(await encodingsM3u8Response.text(), encodingsM3u8Response.url || url);
                            streamInfo.Encodings = encodingsM3u8;
                            setStreamInfoUrls(streamInfo, encodingsM3u8);
                            serverTime = getServerTimeFromM3u8(encodingsM3u8);
                            const resolutionInfo = streamInfo.Urls.values().next().value;
                            const streamM3u8Response = await realFetch(resolutionInfo.Url);
                            if (streamM3u8Response.status == 200) {
                                const streamM3u8 = resolvePlaylistUrls(await streamM3u8Response.text(), streamM3u8Response.url || resolutionInfo.Url);
                                if (hasAdTags(streamM3u8) || SimulatedAdsDepth > 0) {
                                    await onFoundAd(streamInfo, streamM3u8, false, realFetch, resolutionInfo.Url, resolutionInfo);
                                }
                            } else {
                                return streamM3u8Response;
                            }
                        } else {
                            return encodingsM3u8Response;
                        }
                    }
                    if (!serverTime) {
                        const encodingsM3u8Response = await realFetch(url, options);
                        if (encodingsM3u8Response != null && encodingsM3u8Response.status === 200) {
                            serverTime = getServerTimeFromM3u8(await encodingsM3u8Response.text());
                        }
                    }
                    streamInfo.IsMovingOffBackupEncodings = false;
                    return new Response(replaceServerTimeInM3u8(streamInfo.BackupEncodings ? streamInfo.BackupEncodings : streamInfo.Encodings, serverTime));

                }
            }
            return realFetch.apply(this, arguments);
        }
    }
    function getServerTimeFromM3u8(encodingsM3u8) {
        if (V2API) {
            const matches = encodingsM3u8.match(/#EXT-X-SESSION-DATA:DATA-ID="SERVER-TIME",VALUE="([^"]+)"/);
            return matches && matches.length > 1 ? matches[1] : null;
        }
        const matches = encodingsM3u8.match(/SERVER-TIME="([0-9.]+)"/);
        return matches && matches.length > 1 ? matches[1] : null;
    }
    function replaceServerTimeInM3u8(encodingsM3u8, newServerTime) {
        if (V2API) {
            return newServerTime ? encodingsM3u8.replace(/(#EXT-X-SESSION-DATA:DATA-ID="SERVER-TIME",VALUE=")[^"]+(")/, `$1${newServerTime}$2`) : encodingsM3u8;
        }
        return newServerTime ? encodingsM3u8.replace(/(SERVER-TIME=")[0-9.]+"/, `SERVER-TIME="${newServerTime}"`) : encodingsM3u8;
    }
    function getStreamUrlForResolution(encodingsM3u8, resolutionInfo) {
        const encodingsLines = encodingsM3u8.split(/\r?\n/);
        const [targetWidth, targetHeight] = resolutionInfo.Resolution.split('x').map(Number);
        let matchedResolutionUrl = null;
        let matchedFrameRate = false;
        let closestResolutionUrl = null;
        let closestResolutionDifference = Infinity;
        for (let i = 0; i < encodingsLines.length - 1; i++) {
            // Accept v2 API variant URLs (raw CDN URLs without '.m3u8').
            const nextLine = encodingsLines[i + 1]?.trim();
            if (encodingsLines[i].startsWith('#EXT-X-STREAM-INF') && nextLine && !nextLine.startsWith('#') && (nextLine.includes('.m3u8') || nextLine.includes('://'))) {
                const attributes = parseAttributes(encodingsLines[i]);
                const resolution = attributes['RESOLUTION'];
                const frameRate = attributes['FRAME-RATE'];
                if (resolution) {
                    if (resolution == resolutionInfo.Resolution && (!matchedResolutionUrl || (!matchedFrameRate && frameRate == resolutionInfo.FrameRate))) {
                        matchedResolutionUrl = encodingsLines[i + 1];
                        matchedFrameRate = frameRate == resolutionInfo.FrameRate;
                        if (matchedFrameRate) {
                            return matchedResolutionUrl.trimEnd();
                        }
                    }
                    const [width, height] = resolution.split('x').map(Number);
                    const difference = Math.abs((width * height) - (targetWidth * targetHeight));
                    if (difference < closestResolutionDifference) {
                        closestResolutionUrl = encodingsLines[i + 1];
                        closestResolutionDifference = difference;
                    }
                }
            }
        }
        return closestResolutionUrl.trimEnd();
    }
    function getAccessToken(channelName, playerType) {
        const realPlayerType = playerType.replace('-ALT', '');
        const body = {
            operationName: 'PlaybackAccessToken',
            variables: {
                isLive: true,
                login: channelName,
                isVod: false,
                vodID: "",
                playerType: realPlayerType,
                platform: 'web'
            },
            extensions: {
                persistedQuery: {
                    version:1,
                    sha256Hash:"ed230aa1e33e07eebb8928504583da78a5173989fadfb1ac94be06a04f3cdbe9"
                }
            }
        };
        return gqlRequest(body);
    }
    function gqlRequest(body) {
        if (!gql_device_id) {
            gql_device_id = '';
            const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
            for (let i = 0; i < 32; i += 1) {
                gql_device_id += chars.charAt(Math.floor(Math.random() * chars.length));
            }
        }
        let headers = {
            'Client-Id': CLIENT_ID,
            'X-Device-Id': gql_device_id,
            'Authorization': AuthorizationHeader,
            ...(ClientIntegrityHeader && {'Client-Integrity': ClientIntegrityHeader})
        };
        if (playerType.includes('-ALT')) {
            headers = {
                'Client-Id': CLIENT_ID,
                'X-Device-Id': gql_device_id
            };
        }
        return new Promise((resolve, reject) => {
            const requestId = Math.random().toString(36).substring(2, 15);
            const fetchRequest = {
                id: requestId,
                url: 'https://gql.twitch.tv/gql',
                options: {
                    method: 'POST',
                    body: JSON.stringify(body),
                    headers
                }
            };
            const timeoutId = setTimeout(() => {
                if (pendingFetchRequests.has(requestId)) {
                    pendingFetchRequests.delete(requestId);
                    reject(new Error('FetchRequest timed out'));
                }
            }, 15000);
            pendingFetchRequests.set(requestId, {
                resolve,
                reject,
                timeoutId
            });
            postMessage({
                key: 'FetchRequest',
                value: fetchRequest
            });
        });
    }
    function parseAttributes(str) {
        if (!str) return {};
        // Normalize: always pass only attribute section
        if (str.charCodeAt(0) === 35) { // '#'
            const idx = str.indexOf(':');
            if (idx !== -1) str = str.slice(idx + 1);
        }
        return Object.fromEntries(
            str.split(/(?:^|,)((?:[^=]*)=(?:"[^"]*"|[^,]*))/)
                .filter(Boolean)
                .map(x => {
                    const idx = x.indexOf('=');
                    const key = x.substring(0, idx);
                    const value = x.substring(idx +1);
                    const num = Number(value);
                    return [key, Number.isNaN(num) ? value.startsWith('"') ? JSON.parse(value) : value : num]
                }));
    }
    function postTwitchWorkerMessage(key, value) {
        twitchWorkers.forEach((worker) => {
            worker.postMessage({key: key, value: value});
        });
    }
    async function handleWorkerFetchRequest(fetchRequest) {
        // 5s AbortController timeout — bounds worst-case wait when Twitch GQL hangs.
        const controller = new AbortController();
        const timeoutMs = 5000;
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await window.realFetch(fetchRequest.url, {
                ...fetchRequest.options,
                signal: controller.signal
            });
            const responseBody = await response.text();
            const responseObject = {
                id: fetchRequest.id,
                status: response.status,
                statusText: response.statusText,
                ok: response.ok,
                redirected: response.redirected,
                type: response.type,
                url: response.url,
                headers: Object.fromEntries(response.headers.entries()),
                body: responseBody
            };
            return responseObject;
        } catch (error) {
            return {
                id: fetchRequest.id,
                error: error.name === 'AbortError' ? 'GQL fetch timeout (' + (timeoutMs / 1000) + 's)' : error.message
            };
        } finally {
            clearTimeout(timeoutId);
        }
    }
    function hookFetch() {
        console.log('[AD DEBUG] Window fetch hook installed');
        let hasLoggedHeaders = false;
        const realFetch = window.fetch;
        window.realFetch = realFetch;
        window.fetch = maskAsNative(function(url, init) {
            const requestUrl = typeof url === 'string' ? url : url instanceof URL ? url.href : url instanceof Request ? url.url : '';
            if (requestUrl) {
                let gqlUrl;
                try { gqlUrl = new URL(requestUrl); } catch {}
                if (gqlUrl?.origin === 'https://gql.twitch.tv' && gqlUrl.pathname === '/gql' && !gqlUrl.username && !gqlUrl.password) {
                    const headers = new Headers(init?.headers ?? (url instanceof Request ? url.headers : undefined));
                    let deviceId = headers.get('X-Device-Id');
                    if (typeof deviceId !== 'string') {
                        deviceId = headers.get('Device-ID');
                    }
                    if (typeof deviceId === 'string' && gql_device_id != deviceId) {
                        gql_device_id = deviceId;
                        postTwitchWorkerMessage('UboUpdateDeviceId', gql_device_id);
                    }
                    if (typeof headers.get('Client-Integrity') === 'string' && headers.get('Client-Integrity') !== ClientIntegrityHeader) {
                        postTwitchWorkerMessage('UpdateClientIntegrityHeader', ClientIntegrityHeader = headers.get('Client-Integrity'));
                    }
                    if (typeof headers.get('Authorization') === 'string' && headers.get('Authorization') !== AuthorizationHeader) {
                        postTwitchWorkerMessage('UpdateAuthorizationHeader', AuthorizationHeader = headers.get('Authorization'));
                    }
                    if (!hasLoggedHeaders && gql_device_id && AuthorizationHeader) {
                        hasLoggedHeaders = true;
                        console.log('[AD DEBUG] GQL headers captured — DeviceId: ' + (gql_device_id ? 'yes' : 'no') + ', Auth: ' + (AuthorizationHeader ? 'yes' : 'no') + ', Integrity: ' + (ClientIntegrityHeader ? 'yes' : 'no'));
                    }
                    if (OPT_FORCE_ACCESS_TOKEN_PLAYER_TYPE && typeof init?.body === 'string' && init.body.includes('PlaybackAccessToken')) {
                        let replacedPlayerType = '';
                        const newBody = JSON.parse(init.body);
                        if (Array.isArray(newBody)) {
                            for (let i = 0; i < newBody.length; i++) {
                                if (newBody[i]?.operationName?.includes('PlaybackAccessToken') && newBody[i]?.variables?.playerType && newBody[i]?.variables?.playerType !== OPT_FORCE_ACCESS_TOKEN_PLAYER_TYPE) {
                                    replacedPlayerType = newBody[i].variables.playerType;
                                    newBody[i].variables.playerType = OPT_FORCE_ACCESS_TOKEN_PLAYER_TYPE;
                                }
                            }
                        } else {
                            if (newBody?.operationName?.includes('PlaybackAccessToken') && newBody?.variables?.playerType && newBody?.variables?.playerType !== OPT_FORCE_ACCESS_TOKEN_PLAYER_TYPE) {
                                replacedPlayerType = newBody.variables.playerType;
                                newBody.variables.playerType = OPT_FORCE_ACCESS_TOKEN_PLAYER_TYPE;
                            }
                        }
                        if (replacedPlayerType) {
                            console.log(`[AD DEBUG] Replaced '${replacedPlayerType}' player type with '${OPT_FORCE_ACCESS_TOKEN_PLAYER_TYPE}' player type`);
                            init.body = JSON.stringify(newBody);
                        }
                    }
                }
                if (requestUrl.includes('edge.ads.twitch.tv')) {
                    const csaiType = requestUrl.includes('bp=midroll') ? 'midroll' : requestUrl.includes('bp=preroll') ? 'preroll' : 'unknown';
                    if (!loggedCsaiTypes.has(csaiType)) {
                        loggedCsaiTypes.add(csaiType);
                        console.log('[AD DEBUG] CSAI ad request detected — type: ' + csaiType + ' (client-side ad insertion, not blockable via m3u8)');
                    }
                }
            }
            return realFetch.apply(this, arguments);
        }, 'fetch');
    }
    function updateAdblockBanner(data) {
        if (typeof window !== 'undefined' && window.__tasDiagnostics) {
            const current = window.__tasDiagnostics.current;
            if (!!data.hasAds !== current.inAdBreak) recordTASDiagnostic({ event: data.hasAds ? 'ad-start' : 'ad-end' });
            if (data.hasAds && data.activeBackupPlayerType && data.activeBackupPlayerType !== current.backup) {
                recordTASDiagnostic({ event: 'backup-selected', playerType: data.activeBackupPlayerType, quality: data.backupQuality || 'unknown' });
            }
        }
        const playerRootDiv = document.querySelector('.video-player');
        if (playerRootDiv != null) {
            let adBlockDiv = null;
            adBlockDiv = playerRootDiv.querySelector('.tas-adblock-overlay');
            if (adBlockDiv == null) {
                adBlockDiv = document.createElement('div');
                adBlockDiv.className = 'tas-adblock-overlay';
                adBlockDiv.innerHTML = '<div class="player-adblock-notice" style="color: white; background-color: rgba(0, 0, 0, 0.8); position: absolute; top: 0px; left: 0px; padding: 5px;"><p></p></div>';
                adBlockDiv.style.display = 'none';
                adBlockDiv.P = adBlockDiv.querySelector('p');
                playerRootDiv.appendChild(adBlockDiv);
            }
            if (adBlockDiv != null) {
                if (!twitchPlayerAndState?.player?.core || !twitchPlayerAndState?.state) {
                    twitchPlayerAndState = getPlayerAndState();
                }
                const isLive = twitchPlayerAndState?.state?.props?.content?.type === 'live';
                adBlockDiv.P.textContent = 'Blocking' + (data.isMidroll ? ' midroll' : '') + ' ads' + (data.isStrippingAdSegments ? ' (stripping)' : '') + (data.activeBackupPlayerType ? ' (' + data.activeBackupPlayerType + ')' : '');
                adBlockDiv.style.display = data.hasAds && isLive ? 'block' : 'none';
            }
        }
    }
    function monitorLiveStatus() {
        if (!twitchPlayerAndState?.player?.core || !twitchPlayerAndState?.state) {
            twitchPlayerAndState = getPlayerAndState();
        }
        const isLive = twitchPlayerAndState?.state?.props?.content?.type === 'live';
        if (!isLive) {
            updateAdblockBanner({
                hasAds: false
            });
        }
        setTimeout(monitorLiveStatus, 1000);
    }
    function getPlayerAndState() {
        function findReactNode(root, constraint) {
            if (root.stateNode && constraint(root.stateNode)) {
                return root.stateNode;
            }
            let node = root.child;
            while (node) {
                const result = findReactNode(node, constraint);
                if (result) {
                    return result;
                }
                node = node.sibling;
            }
            return null;
        }
        function findReactRootNode() {
            let reactRootNode = null;
            const rootNode = document.querySelector('#root');
            if (rootNode && rootNode._reactRootContainer && rootNode._reactRootContainer._internalRoot && rootNode._reactRootContainer._internalRoot.current) {
                reactRootNode = rootNode._reactRootContainer._internalRoot.current;
            }
            if (reactRootNode == null && rootNode != null) {
                const containerName = Object.keys(rootNode).find(x => x.startsWith('__reactContainer') || x.startsWith('__reactFiber'));
                if (containerName != null) {
                    reactRootNode = rootNode[containerName];
                }
            }
            return reactRootNode;
        }
        const reactRootNode = findReactRootNode();
        if (!reactRootNode) {
            return null;
        }
        // Primary: named property lookup
        let player = findReactNode(reactRootNode, node => node.setPlayerActive && node.props && node.props.mediaPlayerInstance);
        player = player && player.props && player.props.mediaPlayerInstance ? player.props.mediaPlayerInstance : null;
        if (player?.playerInstance) {
            player = player.playerInstance;
        }
        // Fallback: structural match if Twitch obfuscates property names
        if (!player) {
            player = findReactNode(reactRootNode, node => node.getHTMLVideoElement && node.getBufferDuration && node.core?.state);
        }
        // Primary: named property lookup
        const playerState = findReactNode(reactRootNode, node => node.setSrc && node.setInitialPlaybackSettings);
        // Fallback: structural match — setSrc exists but setInitialPlaybackSettings was renamed
        const playerStateFallback = !playerState ? findReactNode(reactRootNode, node => node.setSrc && node.setStreamManagerNode && !node.getHTMLVideoElement) : null;
        // Fallback 2: TTV-AB's approach — videoPlayerInstance with playerMode
        const playerStateFallback2 = !playerState && !playerStateFallback ? findReactNode(reactRootNode, node => node.state?.videoPlayerInstance?.playerMode !== undefined)?.state?.videoPlayerInstance : null;
        const finalPlayerState = playerState || playerStateFallback || playerStateFallback2;
        return  {
            player: player,
            state: finalPlayerState
        };
    }
    function reloadTwitchPlayer(isPausePlay, reloadKind) {
        recordTASDiagnostic({ event: isPausePlay ? 'pause-play' : 'reload-request', reason: reloadKind || 'normal' });
        const playerAndState = getPlayerAndState();
        if (!playerAndState) {
            console.log('Could not find react root');
            return;
        }
        const player = playerAndState.player;
        const playerState = playerAndState.state;
        if (!player) {
            console.log('Could not find player');
            return;
        }
        if (!playerState) {
            console.log('Could not find player state');
            return;
        }
        if (player.isPaused() || player.core?.paused) {
            return;
        }
        // Reload cooldown — skip if last reload was too recent (breaks CSAI cascades).
        // Early reloads (worker-triggered thin-cache / freeze-recovery fast path) bypass
        // the gate but still update bookkeeping so 3+ rapid early reloads still escalate
        // the cooldown the same way buffer-monitor reloads would.
        if (!isPausePlay && ReloadCooldownSeconds > 0) {
            const now = Date.now();
            const cooldownMs = ReloadCooldownSeconds * 1000;
            const isEarly = reloadKind === 'early';
            if (lastReloadTimestamp && now - lastReloadTimestamp < cooldownMs) {
                if (!isEarly) {
                    console.log('[AD DEBUG] Skipping reload — cooldown active (' + Math.round((cooldownMs - (now - lastReloadTimestamp)) / 1000) + 's remaining)');
                    return;
                }
                console.log('[AD DEBUG] Bypassing cooldown for early reload (thin-cache fast path) — ' + Math.round((cooldownMs - (now - lastReloadTimestamp)) / 1000) + 's would have remained');
            }
            // Auto-escalate: if 3+ reloads in 5 minutes, triple the cooldown
            reloadTimestamps.push(now);
            const fiveMinAgo = now - 300000;
            while (reloadTimestamps.length > 0 && reloadTimestamps[0] < fiveMinAgo) { reloadTimestamps.shift(); }
            if (reloadTimestamps.length >= 3 && ReloadCooldownSeconds < 90) {
                EscalatedFromCooldown = ReloadCooldownSeconds;
                ReloadCooldownSeconds = 90;
                console.log('[AD DEBUG] Auto-escalated reload cooldown to 90s (3+ reloads in 5 minutes)');
            } else if (EscalatedFromCooldown !== null && reloadTimestamps.length < 3) {
                console.log('[AD DEBUG] De-escalated reload cooldown back to ' + EscalatedFromCooldown + 's (burst subsided)');
                ReloadCooldownSeconds = EscalatedFromCooldown;
                EscalatedFromCooldown = null;
            }
            lastReloadTimestamp = now;
        }
        if (isPausePlay) {
            player.pause();
            player.play()?.catch?.(() => {});
            return;
        }
        if (document.pictureInPictureElement) {
            // Downgrade to pause/play to preserve PiP — setSrc exits PiP
            player.pause();
            player.play()?.catch?.(() => {});
            console.log('[AD DEBUG] Downgraded reload to pause/play to preserve PiP');
            return;
        }
        const lsKeyQuality = 'video-quality';
        const lsKeyMuted = 'video-muted';
        const lsKeyVolume = 'volume';
        const lsKeyLowLatency = 'lowLatencyModeEnabled';// Preserve user's low-latency toggle across reloads (TTV-AB parity)
        const lsKeyPersistence = 'persistenceEnabled';// Preserve autoplay/persistence toggle across reloads (TTV-AB parity)
        let currentQualityLS = null;
        let currentMutedLS = null;
        let currentVolumeLS = null;
        let currentLowLatencyLS = null;
        let currentPersistenceLS = null;
        try {
            currentQualityLS = localStorage.getItem(lsKeyQuality);
            currentMutedLS = localStorage.getItem(lsKeyMuted);
            currentVolumeLS = localStorage.getItem(lsKeyVolume);
            currentLowLatencyLS = localStorage.getItem(lsKeyLowLatency);
            currentPersistenceLS = localStorage.getItem(lsKeyPersistence);
            if (localStorageHookFailed && player?.core?.state) {
                localStorage.setItem(lsKeyMuted, JSON.stringify({default:player.core.state.muted}));
                localStorage.setItem(lsKeyVolume, player.core.state.volume);
            }
            if (player?.core?.state?.quality?.group) {
                localStorage.setItem(lsKeyQuality, JSON.stringify({default:player.core.state.quality.group}));
            }
        } catch {}
        // Pre-mute through hard reload (setSrc always tears down MSE) to hide the audio
        // click at the MSE discontinuity boundary. Restored on `canplay` with 1500ms cap.
        try {
            const v = document.querySelector('video');
            if (v && !v.muted) {
                v.muted = true;
                // Multi-event restore: canplay/playing/loadeddata — first-fired wins.
                let done = false;
                const restore = () => {
                    if (done) return;
                    done = true;
                    document.removeEventListener('canplay', listener, true);
                    document.removeEventListener('playing', listener, true);
                    document.removeEventListener('loadeddata', listener, true);
                    try {
                        const cur = document.querySelector('video');
                        if (cur) cur.muted = false;
                    } catch {}
                };
                const listener = (e) => {
                    if (e.target && e.target.tagName === 'VIDEO') restore();
                };
                document.addEventListener('canplay', listener, true);
                document.addEventListener('playing', listener, true);
                document.addEventListener('loadeddata', listener, true);
                setTimeout(restore, 4000);// Bumped 2500ms → 4000ms for Edge slow-init slack.
            }
        } catch {}
        playerState.setSrc({ isNewMediaPlayerInstance: true, refreshAccessToken: true });
        player.play()?.catch?.(() => {});
        // Always restore muted/volume state after reload — Chrome autoplay policy can force muted.
        // Block must always run: if Twitch hasn't written LS values yet (fresh session, private mode,
        // cleared cache), the video still needs unmute after Chrome's autoplay mute on reload.
        {
            setTimeout(() => {
                try {
                    if (currentQualityLS) {
                        localStorage.setItem(lsKeyQuality, currentQualityLS);
                    }
                    if (currentMutedLS) {
                        localStorage.setItem(lsKeyMuted, currentMutedLS);
                    }
                    if (currentVolumeLS) {
                        localStorage.setItem(lsKeyVolume, currentVolumeLS);
                    }
                    if (currentLowLatencyLS !== null) {
                        localStorage.setItem(lsKeyLowLatency, currentLowLatencyLS);
                    }
                    if (currentPersistenceLS !== null) {
                        localStorage.setItem(lsKeyPersistence, currentPersistenceLS);
                    }
                    const videos = document.getElementsByTagName('video');
                    // Respect user's mute intent: only force-unmute if LS didn't say mute.
                    // Twitch writes video-muted as '{"default":true}' when user muted via UI;
                    // Chrome autoplay policy can mute even if user didn't (no LS signal).
                    const userIntendedMute = currentMutedLS && currentMutedLS.includes('"default":true');
                    if (videos.length > 0 && videos[0].muted && !userIntendedMute) {
                        videos[0].muted = false;
                    }
                } catch {}
            }, 3000);
        }
    }
    function getTASDiagnostics() {
        const state = window.__tasDiagnostics;
        if (!state) return null;
        return {
            schemaVersion: 1, evidence: 'local diagnostic events; not proof of live playback',
            script: state.script, version: state.version,
            elapsedMs: Math.max(0, Date.now() - state.startedAt),
            current: { ...state.current }, events: state.events.map(event => ({ ...event }))
        };
    }
    function recordTASDiagnostic(data) {
        if (typeof window === 'undefined' || !window.__tasDiagnostics) return;
        const state = window.__tasDiagnostics;
        const allowedEvents = ['backup-attempt', 'backup-selected', 'ad-start', 'ad-end', 'reload-request', 'pause-play', 'worker-error'];
        if (!allowedEvents.includes(data.event)) return;
        const entry = { atMs: Math.max(0, Date.now() - state.startedAt), event: data.event };
        if (data.playerType !== undefined) {
            entry.playerType = ['popout', 'embed', 'site', 'mobile_web', 'autoplay'].includes(data.playerType) ? data.playerType : 'unknown';
        }
        if (data.quality !== undefined) entry.quality = /^\d{1,5}x\d{1,5}$/.test(data.quality) ? data.quality : 'unknown';
        if (Number.isFinite(data.durationMs)) entry.durationMs = Math.min(60000, Math.max(0, data.durationMs));
        if (data.event === 'reload-request') {
            entry.reason = ['early', 'worker-error', 'normal'].includes(data.reason) ? data.reason : 'normal';
            state.current.recovery = entry.reason;
        }
        if (data.event === 'backup-selected') {
            state.current.backup = entry.playerType || 'unknown';
            state.current.quality = entry.quality || 'unknown';
        }
        if (data.event === 'ad-start' || data.event === 'ad-end') {
            state.current.inAdBreak = data.event === 'ad-start';
            state.current.backup = 'none';
            state.current.quality = 'unknown';
        }
        state.events.push(entry);
        if (state.events.length > 100) state.events.shift();
        state.render();
    }
    function initializeTASControls(script, version) {
        if (window.__tasDiagnostics || !document.body) return;
        const state = window.__tasDiagnostics = { script, version, startedAt: Date.now(), events: [],
            current: { backup: 'none', quality: 'unknown', recovery: 'none', inAdBreak: false }, render() {} };
        const host = document.createElement('div');
        host.id = 'tas-controls';
        host.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483646';
        const root = host.attachShadow({ mode: 'open' });
        const style = document.createElement('style');
        style.textContent = `
            :host { font: 14px/1.5 system-ui, sans-serif; color: #eee; }
            button, input, select { font: inherit; }
            button { padding: 8px 12px; min-height: 36px; cursor: pointer; }
            button:focus-visible, input:focus-visible, select:focus-visible { outline: 3px solid #72bcff; outline-offset: 2px; }
            dialog { color: #eee; background: #202024; border: 1px solid #777; border-radius: 8px; padding: 24px; width: min(460px, calc(100vw - 64px)); max-height: calc(100dvh - 64px); overflow: auto; }
            dialog::backdrop { background: rgb(0 0 0 / 65%); }
            h2 { margin: 0 0 12px; font-size: 20px; }
            label { display: block; margin-top: 12px; }
            label.toggle { display: flex; align-items: center; gap: 8px; min-height: 32px; }
            input[type=checkbox] { width: 18px; height: 18px; flex: none; }
            summary { cursor: pointer; padding: 12px 0; }
            input:not([type=checkbox]), select { display: block; box-sizing: border-box; width: 100%; padding: 6px; }
            small { display: block; color: #ccc; }
            .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
            #details { background: #202024; padding: 8px; max-width: 320px; margin-bottom: 8px; }
            #feedback { min-height: 1.5em; }
        `;
        root.appendChild(style);
        const create = (tag, parent, text) => {
            const node = document.createElement(tag);
            if (text) node.textContent = text;
            parent.appendChild(node);
            return node;
        };
        const details = create('div', root);
        details.id = 'details';
        details.hidden = true;
        const trigger = create('button', root, 'Ad blocker settings');
        trigger.type = 'button';
        const dialog = create('dialog', root);
        dialog.setAttribute('aria-labelledby', 'tas-title');
        create('h2', dialog, 'Ad blocker settings').id = 'tas-title';
        create('p', dialog, script + ' ' + version + '. Changes apply after reloading Twitch.');
        const form = create('form', dialog);
        const definitions = [
            ['playerType', 'Token player type', 'popout', ['popout', 'embed', 'site', 'mobile_web', 'autoplay'], 'Autoplay may limit quality to 360p.'],
            ['reloadPlayerAfterAd', 'Prefer a reload after ads', true, 'boolean', 'Required recovery resets can still run when disabled.'],
            ['pinBackupPlayerType', 'Prefer the last working backup', script === 'vaft', 'boolean'],
            ['hideAdOverlay', 'Hide the blocking-ads banner', false, 'boolean'],
            ['showDiagnostics', 'Show backup and recovery status', false, 'boolean'],
            ['reloadCooldownSeconds', 'Reload cooldown in seconds', 30, [0, 3600, 1], '0 disables the cooldown.'],
            ['earlyReloadPollThreshold', 'Early reload poll threshold', script === 'vaft' ? 3 : 5, [0, 100, 1], '0 disables early reloads. A thin recovery cache can trigger sooner.']
        ];
        if (script === 'vaft') definitions.push(
            ['driftCorrectionRate', 'Catch-up playback speed', 1.1, [0, 2, 0.05], '0 disables catch-up.'],
            ['preferLowQualityBackup', 'Allow low-quality backup recovery', true, 'boolean'],
            ['backupSwapFirst', 'Try backup streams before stripping', true, 'boolean'],
            ['fastAutoplayFirstTry', 'Reuse a successful autoplay fallback', true, 'boolean'],
            ['recoverFromSilentMute', 'Recover from silent player muting', true, 'boolean'],
            ['disableAdSpoofing', 'Disable ad-completion spoofing', true, 'boolean'],
            ['disablePostBreakWedge', 'Disable post-break video recovery', false, 'boolean'],
            ['disableReloadCap', 'Allow unlimited recovery reloads', false, 'boolean'],
            ['iosSoftReload', 'Preserve the player on Apple touch devices', true, 'boolean']
        );
        let advanced;
        const fields = definitions.map(([key, title, fallback, type, hint], index) => {
            if (index === 7) {
                advanced = create('details', form);
                create('summary', advanced, 'Advanced recovery settings');
            }
            const parent = advanced || form;
            const id = 'tas-' + key;
            const label = create('label', parent, title);
            label.htmlFor = id;
            const input = create(Array.isArray(type) && typeof type[0] === 'string' ? 'select' : 'input', parent);
            input.id = id;
            if (type === 'boolean') { input.type = 'checkbox'; label.className = 'toggle'; label.prepend(input); }
            else if (input.tagName === 'SELECT') {
                for (const value of type) { const option = create('option', input, value); option.value = value; }
            } else {
                input.type = 'number'; input.min = type[0]; input.max = type[1]; input.step = type[2]; input.required = true;
            }
            if (hint) {
                const help = create('small', parent, hint);
                help.id = id + '-hint'; input.setAttribute('aria-describedby', help.id);
            }
            return { key, fallback, type, input };
        });
        const feedback = create('p', form);
        feedback.id = 'feedback'; feedback.setAttribute('role', 'status');
        const actions = create('div', form); actions.className = 'actions';
        const save = create('button', actions, 'Save settings'); save.type = 'submit';
        const reset = create('button', actions, 'Reset these settings'); reset.type = 'button';
        const download = create('button', actions, 'Export diagnostics'); download.type = 'button';
        const close = create('button', actions, 'Close'); close.type = 'button';
        const storageKey = key => 'twitchAdSolutions_' + key;
        const populate = defaults => {
            for (const field of fields) {
                const stored = defaults ? null : localStorage.getItem(storageKey(field.key));
                const value = stored ?? field.fallback;
                if (field.type === 'boolean') field.input.checked = String(value) === 'true';
                else field.input.value = value;
            }
        };
        state.render = () => {
            details.textContent = 'Backup: ' + state.current.backup + ' | Quality: ' + state.current.quality
                + ' | Last recovery request: ' + state.current.recovery;
        };
        const show = () => {
            feedback.textContent = '';
            try { populate(false); } catch { feedback.textContent = 'Browser storage is unavailable. Settings cannot be saved.'; }
            dialog.showModal();
        };
        trigger.addEventListener('click', show);
        close.addEventListener('click', () => dialog.close());
        dialog.addEventListener('close', () => trigger.focus());
        const persist = defaults => {
            const snapshot = new Map();
            try {
                for (const field of fields) snapshot.set(storageKey(field.key), localStorage.getItem(storageKey(field.key)));
                for (const field of fields) {
                    const key = storageKey(field.key);
                    if (defaults) localStorage.removeItem(key);
                    else localStorage.setItem(key, field.type === 'boolean' ? String(field.input.checked) : field.input.value);
                }
                details.hidden = localStorage.getItem(storageKey('showDiagnostics')) !== 'true';
                if (defaults) populate(true);
                feedback.textContent = 'Settings ' + (defaults ? 'reset' : 'saved') + '. Reload Twitch to apply playback changes.';
            } catch {
                for (const [key, value] of snapshot) {
                    try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* Storage can remain unavailable. */ }
                }
                feedback.textContent = 'Could not save settings. Browser storage is unavailable.';
            }
        };
        form.addEventListener('submit', event => {
            event.preventDefault();
            if (form.reportValidity()) persist(false);
        });
        reset.addEventListener('click', () => persist(true));
        download.addEventListener('click', () => {
            const report = getTASDiagnostics();
            const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2) + '\n'], { type: 'application/json' }));
            const link = create('a', root);
            link.href = url; link.download = 'twitch-ad-solutions-diagnostics.json'; link.click(); link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        });
        document.body.appendChild(host);
        try { details.hidden = localStorage.getItem(storageKey('showDiagnostics')) !== 'true'; } catch { /* Settings remain accessible without storage. */ }
        state.render();
        window.twitchAdSolutionsTools = { openSettings: show, diagnostics: getTASDiagnostics };
    }
    function onContentLoaded() {
        initializeTASControls('video-swap-new', '1.91');
        if (document.getElementById('seventv-extension')) {
            console.log('[AD DEBUG] Warning: 7TV extension detected — may cause black screen or buffering issues. If you experience problems, try disabling 7TV.');
        }
        // Resume the player on tab focus if Twitch paused it during an ad on a hidden tab.
        // Previously also spoofed document.hidden / visibilityState / hasFocus / mozHidden /
        // webkitHidden and swallowed the events on the capture phase. That broke other
        // extensions that key off real visibility (e.g. BetterTTV "Mute Invisible Player").
        // Resume-on-focus alone is enough to keep playback alive across hidden→visible
        // transitions during ads. Sync'd with TTV-AB v6.5.0.
        let wasVideoPlaying = false;
        const visibilityChange = () => {
            const playerAndState = getPlayerAndState();
            const video = playerAndState?.player?.getHTMLVideoElement?.();
            if (!video || playerAndState?.state?.props?.content?.type !== 'live') {
                wasVideoPlaying = false;
                return;
            }
            if (document.hidden) {
                wasVideoPlaying = !video.paused && !video.ended;
                return;
            }
            if (wasVideoPlaying && !video.ended && video.paused) {
                video.play()?.catch?.(() => {});
            }
            wasVideoPlaying = false;
        };
        document.addEventListener('visibilitychange', visibilityChange);
        // Hooks for preserving volume / resolution
        try {
            const keysToCache = [
                'video-quality',
                'video-muted',
                'volume',
                'lowLatencyModeEnabled',// Low Latency
                'persistenceEnabled',// Mini Player
            ];
            const cachedValues = new Map();
            for (let i = 0; i < keysToCache.length; i++) {
                cachedValues.set(keysToCache[i], localStorage.getItem(keysToCache[i]));
            }
            const realSetItem = localStorage.setItem;
            localStorage.setItem = maskAsNative(function(key, value) {
                if (cachedValues.has(key)) {
                    cachedValues.set(key, value);
                }
                realSetItem.apply(this, arguments);
            }, 'setItem');
            const realGetItem = localStorage.getItem;
            localStorage.getItem = maskAsNative(function(key) {
                if (cachedValues.has(key)) {
                    return cachedValues.get(key);
                }
                return realGetItem.apply(this, arguments);
            }, 'getItem');
            if (localStorage.getItem === realGetItem) {
                // These hooks are useful to preserve player state on player reload
                // Firefox doesn't allow hooking of localStorage functions but chrome does
                localStorageHookFailed = true;
            }
        } catch (err) {
            console.log('localStorageHooks failed ' + err)
            localStorageHookFailed = true;
        }
    }
    window.reloadTwitchPlayer = reloadTwitchPlayer;
    declareOptions(window);
    try {
        const lsReloadAfterAd = localStorage.getItem('twitchAdSolutions_reloadPlayerAfterAd');
        if (lsReloadAfterAd !== null) {
            ReloadPlayerAfterAd = lsReloadAfterAd === 'true';
        }
        const lsPlayerType = localStorage.getItem('twitchAdSolutions_playerType');
        if (lsPlayerType !== null) {
            OPT_FORCE_ACCESS_TOKEN_PLAYER_TYPE = lsPlayerType;
        }
        const lsPinBackup = localStorage.getItem('twitchAdSolutions_pinBackupPlayerType');
        if (lsPinBackup !== null) {
            PinBackupPlayerType = lsPinBackup === 'true';
        }
        const lsCooldown = parseInt(localStorage.getItem('twitchAdSolutions_reloadCooldownSeconds'));
        if (!isNaN(lsCooldown) && lsCooldown >= 0) {
            ReloadCooldownSeconds = lsCooldown;
        }
        const lsEarlyReload = parseInt(localStorage.getItem('twitchAdSolutions_earlyReloadPollThreshold'));
        if (!isNaN(lsEarlyReload) && lsEarlyReload >= 0) {
            EarlyReloadPollThreshold = lsEarlyReload;
        }
        const lsHideAdOverlay = localStorage.getItem('twitchAdSolutions_hideAdOverlay');
        if (lsHideAdOverlay === 'true') {
            const style = document.createElement('style');
            style.textContent = '.tas-adblock-overlay { display: none !important; }';
            (document.head || document.documentElement).appendChild(style);
        }
    } catch {}
    console.log('[AD DEBUG] Config: ReloadPlayerAfterAd = ' + ReloadPlayerAfterAd + ', ForceAccessTokenPlayerType = ' + OPT_FORCE_ACCESS_TOKEN_PLAYER_TYPE + ', PinBackupPlayerType = ' + PinBackupPlayerType);
    hookWindowWorker();
    hookFetch();
    const realXHROpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = maskAsNative(function(method, url) {
        if (typeof url === 'string' && url.includes('edge.ads.twitch.tv')) {
            const csaiType = url.includes('bp=midroll') ? 'midroll' : url.includes('bp=preroll') ? 'preroll' : 'unknown';
            const xhrKey = csaiType + '-xhr';
            if (!loggedCsaiTypes.has(xhrKey)) {
                loggedCsaiTypes.add(xhrKey);
                console.log('[AD DEBUG] CSAI ad request (XHR) detected — type: ' + csaiType);
            }
        }
        return realXHROpen.apply(this, arguments);
    }, 'open');
    monitorLiveStatus();
    if (document.readyState === "complete" || document.readyState === "interactive") {
        onContentLoaded();
    } else {
        window.addEventListener("DOMContentLoaded", function() {
            onContentLoaded();
        });
    }
    window.simulateAds = (depth) => {
        if (depth === undefined || depth < 0) {
            console.log('Ad depth paramter required (0 = no simulated ad, 1+ = use backup player for given depth)');
            return;
        }
        postTwitchWorkerMessage('SimulateAds', depth);
    };
    window.allSegmentsAreAdSegments = () => {
        postTwitchWorkerMessage('AllSegmentsAreAdSegments');
    };
})();
