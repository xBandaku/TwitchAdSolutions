<!-- markdownlint-disable MD033 MD041 -->
<div align="center">

# TwitchAdSolutions

[![Version](https://img.shields.io/github/v/release/xBandaku/TwitchAdSolutions?color=%230567ff&label=Latest%20Release&style=for-the-badge)](https://github.com/xBandaku/TwitchAdSolutions/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/xBandaku/TwitchAdSolutions/total?label=Total%20Downloads&style=for-the-badge)](https://github.com/xBandaku/TwitchAdSolutions/releases)
[![License](https://img.shields.io/github/license/xBandaku/TwitchAdSolutions?style=for-the-badge)](LICENSE)

</div>
<!-- markdownlint-enable MD033 MD041 -->

Twitch ad-blocking scripts for Violentmonkey and uBlock Origin. Start with `vaft`. Playback can pause or temporarily drop to 360p during an ad break.

`master` is the only project branch. Install links below follow it; [releases](https://github.com/xBandaku/TwitchAdSolutions/releases) provide versioned downloads and patch notes.

Fork of [ryanbr/TwitchAdSolutions](https://github.com/ryanbr/TwitchAdSolutions), originally based on [pixeltris/TwitchAdSolutions](https://github.com/pixeltris/TwitchAdSolutions).

## Install

Run one Twitch-specific ad blocker at a time. Replace any older TwitchAdSolutions installation before installing.

### Violentmonkey

1. Install [Violentmonkey](https://violentmonkey.github.io/).
2. Open [vaft.user.js](https://raw.githubusercontent.com/xBandaku/TwitchAdSolutions/master/vaft/vaft.user.js) and confirm installation. If your browser downloads the file, import it through Violentmonkey's dashboard.
3. Reload Twitch.

[Tampermonkey](https://www.tampermonkey.net/) and [Userscripts for Safari](https://apps.apple.com/us/app/userscripts/id1463298887) are also supported. Greasemonkey is incompatible. Check the [troubleshooting guide](issues.md) if your browser requires extra userscript permissions.

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

| Script | Userscript | uBlock Origin |
| --- | --- | --- |
| vaft (recommended) | [Install](https://raw.githubusercontent.com/xBandaku/TwitchAdSolutions/master/vaft/vaft.user.js) | [Resource](https://raw.githubusercontent.com/xBandaku/TwitchAdSolutions/master/vaft/vaft-ublock-origin.js) |
| video-swap-new | [Install](https://raw.githubusercontent.com/xBandaku/TwitchAdSolutions/master/video-swap-new/video-swap-new.user.js) | [Resource](https://raw.githubusercontent.com/xBandaku/TwitchAdSolutions/master/video-swap-new/video-swap-new-ublock-origin.js) |

Vaft looks for a clean backup stream and strips ad segments when one is unavailable. `video-swap-new` is an alternative backup-stream implementation. Choose one script.

## Configuration

Defaults work without setup. To change a setting, open the browser console on Twitch, set its `localStorage` value, and reload the page. Removing the value restores the default.

Each setting below starts with `twitchAdSolutions_`.

| Setting | Default | Effect |
| --- | --- | --- |
| `reloadPlayerAfterAd` | `true` | Prefer a reload after ads. Set to `false` to prefer pause/play; required recovery reloads can still run. |
| `playerType` | `popout` | Player context for token requests, such as `popout`, `embed`, `site`, or `autoplay`. Autoplay can limit quality to 360p. |
| `hideAdOverlay` | Unset | Set to `true` to hide the "Blocking ads" banner. |
| `pinBackupPlayerType` | vaft: `true`; video-swap-new: `false` | Remember successful backups. Vaft also promotes Source-quality backups independently and never pins `autoplay` through this setting. |
| `reloadCooldownSeconds` | `30` | Base cooldown in seconds. Some recovery paths bypass it. Set to `0` to disable. |
| `disableReloadCap` | Unset; vaft only | Set to `true` to allow repeated buffer-monitor reloads. This can cause reload loops. |
| `preferLowQualityBackup` | `true`; vaft only | Allow the 360p autoplay fallback and legacy strip-path escape hatch. Set to `false` to disable both. |
| `backupSwapFirst` | `true`; vaft only | Try backup streams when ads are detected. Set to `false` for the legacy strip-first path. |

For example, hide the banner with:

```js
localStorage.setItem('twitchAdSolutions_hideAdOverlay', 'true');
```

Restore the default with `localStorage.removeItem('twitchAdSolutions_hideAdOverlay')`.

During an autoplay backup, Twitch's quality menu can still show Source while playback is at 360p. Vaft attempts to restore full quality when the break ends.

## Troubleshooting

Check that the script is enabled and has the required browser permissions. Disable other Twitch-specific ad blockers, then reload Twitch. If playback problems continue, test with other Twitch player extensions disabled too.

See the [troubleshooting guide](issues.md) for freezing, buffering, and missing injection. To [report a bug](https://github.com/xBandaku/TwitchAdSolutions/issues/new), include your browser, script version, Twitch extensions, and relevant `[AD DEBUG]` console messages.

The [solution list](full-list.md) covers proxies, alternate players, and other tools.

## Development

Use Node.js 22 or 24 and Python 3. Changes go to `master` after validation.

```sh
npm ci --ignore-scripts
npm run lint
npm test
npm run test:package
npx playwright install
npm run test:browser
```

Run `npm run benchmark` for timings against the current vaft functions. Strip measurements include stream setup and cache reset.

ESLint checks source and tests, including uBlock files with their resource headers removed during linting. Existing lint violations are recorded in `eslint-suppressions.json`; new violations fail the check.

Checks cover syntax, metadata, matching userscript/uBlock logic, serialized workers, and runtime regressions. Packaging writes the supported scripts and SHA256SUMS to `release-artifact/`.

Browser tests use offline Twitch pages in Chromium, Firefox, and WebKit. Recovery fixtures use native media with simulated player and PiP state. Windows WebKit skips the PCM media cases; Linux CI runs them. Live ad delivery and extension installation need manual testing.

## License

[MIT](LICENSE). See [CHANGELOG.md](CHANGELOG.md) for release history.
