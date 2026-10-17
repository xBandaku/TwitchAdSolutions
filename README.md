# TwitchAdSolutions

Twitch ad-blocking scripts for userscript managers and uBlock Origin. Start with `vaft`. Playback can pause or temporarily drop to 360p during ads.

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

## Configuration

No configuration is required. In vaft and video-swap-new, use **Ad blocker settings** in the bottom-right corner of Twitch to change playback preferences. The panel validates values and can reset its settings to defaults. Reload Twitch after saving to apply playback changes.

Enable **Show backup and recovery status** for the backup type, selected playlist resolution (or `unknown`), and latest recovery request. **Export diagnostics** downloads the last 100 local events, including backup attempts and selection timing. It excludes channel names, playlist URLs, tokens and request headers; it sends nothing automatically. An event records a request or selection, not proof that playback recovered.

Console configuration is also available. Each setting uses the `twitchAdSolutions_` prefix. For example, hide the "Blocking ads" banner with:

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

During an autoplay backup, Twitch's quality menu can still show Source while playback is at 360p. Vaft attempts to restore full quality when the break ends.

## Troubleshooting

Check that the script is enabled and has the required browser permissions, then reload Twitch. Disable other Twitch-specific ad blockers. If playback problems continue, disable other Twitch player extensions too.

See the [troubleshooting guide](issues.md) for freezing, buffering, and missing injection. To [report a bug](https://github.com/xBandaku/TwitchAdSolutions/issues/new), include your browser, script version, Twitch extensions, and relevant `[AD DEBUG]` console messages.

For other options, see the [solution list](full-list.md).

## Development

Use Node.js 22 or 24 and Python 3. Run the checks before submitting changes:

```sh
npm ci --ignore-scripts
npm run lint
npm test
npm run test:package
npx playwright install
npm run test:browser
```

Run `npm run benchmark` for vaft timings. Existing lint violations are tracked in `eslint-suppressions.json`; new violations fail lint.

Tests check syntax, metadata, matching userscript/uBlock logic, serialized workers, and runtime regressions. Packaging writes scripts and `SHA256SUMS` to `release-artifact/`.

Browser tests use offline Twitch fixtures in Chromium, Firefox, and WebKit. Windows WebKit skips PCM media cases; Linux CI runs them. Live ads and extension installation need manual testing.

### Test evidence

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
