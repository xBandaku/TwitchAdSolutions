<h1 align="center">TwitchAdSolutions</h1>

<p align="center">
  <a href="https://github.com/xBandaku/TwitchAdSolutions/releases"><img src="https://img.shields.io/github/v/release/xBandaku/TwitchAdSolutions?display_name=tag&label=version" alt="Latest version"></a>
  <a href="https://github.com/xBandaku/TwitchAdSolutions/stargazers"><img src="https://img.shields.io/github/stars/xBandaku/TwitchAdSolutions?style=flat" alt="GitHub stars"></a>
  <a href="https://github.com/xBandaku/TwitchAdSolutions/releases"><img src="https://img.shields.io/github/downloads/xBandaku/TwitchAdSolutions/total?label=downloads" alt="Total downloads"></a>
</p>

<p align="center">
  Twitch ad-blocking scripts for userscript managers and uBlock Origin. Start with <strong>vaft</strong>.<br>
  Playback may pause or temporarily drop to 360p during ads.
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#scripts">Scripts</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#troubleshooting">Troubleshooting</a> ·
  <a href="#development">Development</a>
</p>

## Install

Use one Twitch-specific ad blocker at a time. Remove older TwitchAdSolutions installations first, then choose one method below.

### Violentmonkey

1. Install [Violentmonkey](https://violentmonkey.github.io/).
2. Open [vaft.user.js](https://raw.githubusercontent.com/xBandaku/TwitchAdSolutions/master/vaft/vaft.user.js) and confirm installation. If your browser downloads the file, import it through Violentmonkey's dashboard.
3. Reload Twitch.

[Tampermonkey](https://www.tampermonkey.net/) and [Userscripts for Safari](https://apps.apple.com/us/app/userscripts/id1463298887) also work. Greasemonkey is incompatible. See [troubleshooting](issues.md) for userscript permissions.

### uBlock Origin

1. Open the uBlock Origin dashboard. Add this to **My filters** and apply your changes:

   ```text
   twitch.tv##+js(twitch-videoad)
   ```

2. In **Settings**, enable **I am an advanced user** and open the cog beside it.
3. Set this value and apply your changes:

   ```text
   userResourcesLocation https://raw.githubusercontent.com/xBandaku/TwitchAdSolutions/master/vaft/vaft-ublock-origin.js
   ```

   If you already use custom resources, append the URL with a space between entries. See uBlock Origin's [advanced settings](https://github.com/gorhill/uBlock/wiki/Advanced-settings#userresourceslocation).

4. Disable and re-enable uBlock Origin, or restart your browser, then reload Twitch.

To uninstall, remove the filter and this resource URL. Set `userResourcesLocation` back to `unset` only if no other custom resources remain.

## Scripts

`vaft` tries backup streams, then strips ad segments if none are available. If it doesn't work for you, try `video-swap-new`, which uses a different backup-stream implementation. Use the same installation steps with its link below.

| Script | Userscript | uBlock Origin |
| --- | --- | --- |
| vaft (recommended) | [Install](https://raw.githubusercontent.com/xBandaku/TwitchAdSolutions/master/vaft/vaft.user.js) | [Resource](https://raw.githubusercontent.com/xBandaku/TwitchAdSolutions/master/vaft/vaft-ublock-origin.js) |
| video-swap-new | [Install](https://raw.githubusercontent.com/xBandaku/TwitchAdSolutions/master/video-swap-new/video-swap-new.user.js) | [Resource](https://raw.githubusercontent.com/xBandaku/TwitchAdSolutions/master/video-swap-new/video-swap-new-ublock-origin.js) |
| twitch-brave-fix (Brave only, add alongside vaft or video-swap-new) | [Install](https://raw.githubusercontent.com/xBandaku/TwitchAdSolutions/master/vaft/twitch-brave-fix.user.js) | [Resource](https://raw.githubusercontent.com/xBandaku/TwitchAdSolutions/master/vaft/twitch-brave-fix-ublock-origin.js) |

The Brave helper works around Brave fingerprint detection on Twitch requests and skips installation on other browsers. Its uBlock Origin version covers only the JavaScript spoofs; retrying rejected requests with rewritten headers needs the userscript.

## Configuration

No configuration is required.

### Settings panel

In vaft and video-swap-new, open **Ad blocker settings** in the bottom-right corner of Twitch to change playback preferences. The panel validates settings and can reset them to defaults. Choose **Settings button position** to move it, or enable **Hide settings button**. Press **Alt+Shift+A** outside a text field to reopen a hidden panel. Position and visibility changes apply immediately and persist; reload Twitch after saving playback changes.

Vaft's **Advanced recovery settings > Refresh the page if player recovery fails** option is off by default. After two failed recovery attempts and another 3 seconds without playback progress, it can refresh the page. It respects pauses and navigation and runs at most once every 5 minutes per tab; unavailable tab storage disables the fallback. A refresh can trigger another ad and interrupt chat.

### Diagnostics

Enable **Show backup and recovery status** to see the backup type, selected playlist resolution (or `unknown`), and latest recovery request. The **Playback timeline** shows up to 20 of the newest 100 local events, distinguishing recovery requests from completed outcomes.

Worker interception status is **confirmed** when the active worker acknowledges hook initialization, **intercepted** while acknowledgement is absent, **unknown** when Twitch's worker handle is inaccessible, or **possible-miss** when the accessible active worker is not recognized. Confirmation does not establish that every playlist is filtered. These observations never trigger a reload.

Request outcomes distinguish token API errors, HTTP failures, invalid playlist/token responses, and network, body-read or timeout failures for observed token and playlist requests. Timing and readable HTTP status are included. A valid playlist response does not prove segment delivery or playback, and a network error does not identify whether the browser, an extension or the network blocked it. No extra diagnostic network requests are sent.

**Export diagnostics** downloads the event log. **Generate bug report** creates a ready-to-paste report using the repository's issue-template headings, including the current playback snapshot and recent events. Fill in the browser, extension, console, and troubleshooting details that the script cannot know, then review and **Copy report** to share it manually. Reports are never sent automatically and omit channel names, playlist URLs, tokens, and request headers. Events describe observed requests and state; they do not prove playback recovered.

### Settings backup

Use **Export settings** to download a versioned JSON backup. **Import settings** accepts backups for the same script only, validates all values before applying them, and rejects malformed or oversized files. Settings are stored locally; reload Twitch after importing to apply playback changes.

### Advanced settings

Each console setting uses the `twitchAdSolutions_` prefix. For example, hide the "Blocking ads" banner with:

```js
localStorage.setItem('twitchAdSolutions_hideAdOverlay', 'true');
```

To restore the default, remove the value and reload:

```js
localStorage.removeItem('twitchAdSolutions_hideAdOverlay');
```

| Setting | Default | Effect |
| --- | --- | --- |
| `reloadPlayerAfterAd` | `true` | Prefer reloading after ads. Set to `false` to prefer pause/play; required recovery reloads still run. |
| `playerType` | `popout` | Player type for token requests: `popout`, `embed`, `site`, or `autoplay`. Autoplay can limit quality to 360p. |
| `hideAdOverlay` | Unset | Set to `true` to hide the "Blocking ads" banner. |
| `pinBackupPlayerType` | vaft: `true`; video-swap-new: `false` | Remember successful backups. Vaft also promotes Source-quality backups separately; this setting never pins `autoplay`. |
| `reloadCooldownSeconds` | `30` | Seconds between reloads. Some recovery paths bypass this cooldown. Set to `0` to disable it. |
| `disableReloadCap` | Unset; vaft only | Set to `true` to allow repeated buffer-monitor reloads. This can cause reload loops. |
| `preferLowQualityBackup` | `true`; vaft only | Allow the 360p autoplay fallback, including recovery from stalled ad stripping. Set to `false` to disable both. |
| `backupSwapFirst` | `true`; vaft only | Try backup streams first. Set to `false` to strip ad segments first. |
| `earlyReloadPollThreshold` | vaft: `3`; video-swap-new: `5` | Polls (about 2 seconds each) of fully stripped playback before an early reload. Set to `0` to disable. |
| `driftCorrectionRate` | `1.1`; vaft only | Playback rate used to catch up to live after a reload. Set to `0` to disable. |
| `fastAutoplayFirstTry` | `true`; vaft only | Try the 360p autoplay backup first when the previous break ended on it. Set to `false` to probe Source-quality backups every break. |
| `recoverFromSilentMute` | `true`; vaft only | Unmute after a reload if you had unmuted earlier in the session. Set to `false` to keep a mute across reloads. |
| `disableAdSpoofing` | `true`; vaft only | Ad-tracking beacons are not sent. Set to `false` to send them. |
| `disablePostBreakWedge` | Unset; vaft only | Set to `true` to turn off recovery for frozen video with running audio after a break. |
| `iosSoftReload` | `true`; vaft only | On Apple touch devices, keep the existing player when reloading. Set to `false` to replace it. |
| `alignBackupSequence` | `true`; vaft only | Renumber a backup stream's segments to match the live stream so the player does not skip them. Set to `false` to keep the backup's own numbering. |
| `keepBackupSessions` | `true`; vaft only | Keep using an ad-laden backup stream for up to 60 seconds of ads instead of requesting a new one on every poll, since each new one starts with its own preroll. Set to `false` to request a new one every time. |
| `untrackedReload` | `true`; vaft only | Reload the player (at most twice in 10 minutes) when a live playlist vaft never registered carries ads. Set to `false` to disable. |
| `unhookedPageReload` | `true`; vaft only | When the player was created before vaft loaded and a player reload does not fix it, reload the page once (at most every 10 minutes per tab). Set to `false` to only log it. |

During an autoplay backup, Twitch's quality menu can still show Source while playback is at 360p. Vaft attempts to restore full quality when the break ends.

## Troubleshooting

Check that the script is enabled and has the required browser permissions, then reload Twitch. Disable other Twitch-specific ad blockers. If playback problems continue, disable other Twitch player extensions too.

See the [troubleshooting guide](issues.md) for freezing, buffering, and missing injection. To [report a bug](https://github.com/xBandaku/TwitchAdSolutions/issues/new), include your browser, script version, Twitch extensions, and relevant `[AD DEBUG]` console messages.

For other options, see the [solution list](full-list.md).

## Development

See [Development requirements](REQUIREMENTS.md) for prerequisites, repeatable
dependency installation, and the full local verification commands.

### Checks

Run `npm run benchmark` for vaft timings. Existing lint violations are tracked in `eslint-suppressions.json`; new violations fail lint.

Tests check syntax, metadata, matching userscript/uBlock logic, serialized workers, and runtime regressions. Packaging writes scripts and `SHA256SUMS` to `release-artifact/`.

### Browser coverage

Browser tests use offline Twitch fixtures in Chromium, Firefox, and WebKit. Windows WebKit skips PCM media cases; Linux CI runs them. Live ads and extension installation need manual testing.

### Evidence and captures

`npm test` runs captured-response checks first, then synthetic resilience tests and repository checks. Run `npm run test:captured` or `npm run test:resilience` separately when needed. Browser tests are labeled synthetic unless they replay a recorded response.

Captured fixtures contain sanitized master and media playlists, capture time, endpoint, player type, request parameters, HTTP status, final URL, redirect history, and redaction notes. Tests verify body hashes and report whether enhanced-codec rewriting and the missing-resolution guard were exercised. Successful requests without the trigger do not validate those paths.

To capture a currently live channel, run:

```sh
npm run capture:playlist -- CHANNEL tests/fixtures/captured/NEW-CAPTURE.json popout v2
```

Use a lowercase channel login and a new filename. The command makes anonymous live requests, redacts tokens and identifying metadata, and refuses to overwrite a fixture. Review redactions before committing. Normal tests replay committed files without network access. Keep hypothetical redirects and missing-field mutations in synthetic tests; do not edit captures to manufacture a trigger.

Findings and PRs must state `confirmed live`, `reproduced from a captured response`, or `synthetic edge case`, plus any missing evidence. Offline replay does not prove live playback impact. Synthetic-only fixes are preventive hardening.

Verify each regression against its pre-fix source and the working tree. For the missing-resolution case:

```sh
npm run test:regression -- ae97abc "preserves enhanced variants without resolution" "Cannot read properties of undefined (reading 'split')"
```

This command requires the selected tests to fail before the fix with the expected error and pass afterward. It does not change their evidence classification.

## Credits and license

Fork of [ryanbr/TwitchAdSolutions](https://github.com/ryanbr/TwitchAdSolutions), originally based on [pixeltris/TwitchAdSolutions](https://github.com/pixeltris/TwitchAdSolutions).

[MIT](LICENSE). See [releases](https://github.com/xBandaku/TwitchAdSolutions/releases) for versioned downloads and [CHANGELOG.md](CHANGELOG.md) for release history.
