<!-- markdownlint-disable MD033 MD041 -->
<div align="center">

# TwitchAdSolutions

[![Version](https://img.shields.io/github/v/release/xBandaku/TwitchAdSolutions?color=%230567ff&label=Latest%20Release&style=for-the-badge)](https://github.com/xBandaku/TwitchAdSolutions/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/xBandaku/TwitchAdSolutions/total?label=Total%20Downloads&style=for-the-badge)](https://github.com/xBandaku/TwitchAdSolutions/releases)
[![License](https://img.shields.io/github/license/xBandaku/TwitchAdSolutions?style=for-the-badge)](LICENSE)

</div>
<!-- markdownlint-enable MD033 MD041 -->

Scripts for blocking Twitch ads with a userscript manager or uBlock Origin. Use `vaft` to get started.

Fork of [ryanbr/TwitchAdSolutions](https://github.com/ryanbr/TwitchAdSolutions), originally based on [pixeltris/TwitchAdSolutions](https://github.com/pixeltris/TwitchAdSolutions) (archived).

Run only one Twitch-specific ad blocker at a time.

## Contents

- [Install](#install)
- [Scripts](#scripts)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)
- [Other solutions](#other-solutions)
- [Development checks](#development-checks)
- [License](#license)

## Install

### Violentmonkey

1. Install [Violentmonkey](https://violentmonkey.github.io/) in your browser.
2. Open the [latest stable vaft userscript](https://github.com/xBandaku/TwitchAdSolutions/releases/latest/download/vaft.user.js) and confirm installation in Violentmonkey. If your browser downloads the file, import `vaft.user.js` through Violentmonkey's dashboard.
3. Reload any open Twitch stream.

See the [release notes](https://github.com/xBandaku/TwitchAdSolutions/releases/latest) for changes and testing limits.

[Tampermonkey](https://www.tampermonkey.net/) and [Userscripts for Safari](https://apps.apple.com/us/app/userscripts/id1463298887) are other supported managers. Greasemonkey doesn't work with the scripts.

On browsers that require userscript permissions, enable them in the extension settings. See [troubleshooting](issues.md) for details.

### uBlock Origin

1. Open the uBlock Origin dashboard. In **My filters**, add the following filter and apply your changes:

   ```text
   twitch.tv##+js(twitch-videoad)
   ```

2. In **Settings**, enable **I am an advanced user** and open the cog beside it.
3. Set `userResourcesLocation` to the stable vaft resource below and apply your changes:

   ```text
   userResourcesLocation https://raw.githubusercontent.com/xBandaku/TwitchAdSolutions/v68.5.10/vaft/vaft-ublock-origin.js
   ```

   If you already use custom resources, append this URL with a space between entries. See uBlock Origin's [advanced settings](https://github.com/gorhill/uBlock/wiki/Advanced-settings#userresourceslocation).

4. Disable and re-enable uBlock Origin, or restart your browser, then reload Twitch.

The versioned resource stays on v68.5.10 until you update its URL. To uninstall, remove the filter and this resource URL. Set `userResourcesLocation` back to `unset` only if no other custom resources remain.

## Scripts

`vaft` is the recommended script for this fork. It looks for a clean backup stream and can strip ad segments when a clean stream is unavailable. Playback may pause or drop to 360p during an ad break.

| Script | Userscript | uBlock Origin |
| --- | --- | --- |
| vaft | [Stable release](https://github.com/xBandaku/TwitchAdSolutions/releases/latest/download/vaft.user.js) / [master](https://github.com/xBandaku/TwitchAdSolutions/raw/master/vaft/vaft.user.js) | [v68.5.10](https://raw.githubusercontent.com/xBandaku/TwitchAdSolutions/v68.5.10/vaft/vaft-ublock-origin.js) / [master](https://raw.githubusercontent.com/xBandaku/TwitchAdSolutions/master/vaft/vaft-ublock-origin.js) |
| video-swap-new | [master](https://github.com/xBandaku/TwitchAdSolutions/raw/master/video-swap-new/video-swap-new.user.js) | [v68.5.10](https://raw.githubusercontent.com/xBandaku/TwitchAdSolutions/v68.5.10/video-swap-new/video-swap-new-ublock-origin.js) / [master](https://raw.githubusercontent.com/xBandaku/TwitchAdSolutions/master/video-swap-new/video-swap-new-ublock-origin.js) |

`master` links follow the current branch and can include changes that have not been released. `video-swap-new` is an alternative backup-stream implementation; start with vaft.

## Configuration

Defaults work without setup. To change a setting, open the browser console on Twitch, set its `localStorage` value, and reload the page. Removing a value restores its default.

All keys below start with `twitchAdSolutions_`. For example, `hideAdOverlay` uses the full key `twitchAdSolutions_hideAdOverlay`.

| Setting | Default | Effect |
| --- | --- | --- |
| `reloadPlayerAfterAd` | `true` | Prefer a player reload after ads. Set to `false` to prefer pause/play; required recovery reloads can still run. |
| `playerType` | `popout` | Player context for access-token requests, such as `popout`, `embed`, `site`, or `autoplay`. Autoplay can limit video quality to 360p. |
| `hideAdOverlay` | Unset | Set to `true` to hide the "Blocking ads" banner. |
| `pinBackupPlayerType` | vaft: `true`; video-swap-new: `false` | Remember successful backups and try them first. Vaft also promotes Source-quality backups independently and never pins `autoplay` through this setting. |
| `reloadCooldownSeconds` | `30` | Base reload cooldown in seconds. Some recovery paths bypass it; this is not a limit on every reload. Set to `0` to disable the cooldown. |
| `disableReloadCap` | Unset; vaft only | Set to `true` to allow repeated buffer-monitor reloads within a recovery window. This can cause reload loops. |
| `preferLowQualityBackup` | `true`; vaft only | Allow the 360p autoplay fallback and the legacy strip-path escape hatch. Set to `false` to disable both. |
| `backupSwapFirst` | `true`; vaft only | Try backup streams when ads are detected. Set to `false` to use the legacy strip-first path. |

Vaft can temporarily use a 360p autoplay backup while Twitch's quality menu still shows Source quality. It attempts to restore full quality when the ad break ends.

For example, hide the banner with:

```js
localStorage.setItem('twitchAdSolutions_hideAdOverlay', 'true');
```

Restore it with:

```js
localStorage.removeItem('twitchAdSolutions_hideAdOverlay');
```

## Troubleshooting

1. Check that the userscript is enabled and has the required browser permissions, then reload Twitch.
2. Disable other Twitch-specific ad blockers. If playback problems continue, test with other Twitch player extensions disabled too.
3. For freezing, buffering, or missing injection, see the [troubleshooting guide](issues.md).

If the problem persists, [open an issue in this fork](https://github.com/xBandaku/TwitchAdSolutions/issues/new). Include your browser, script version, enabled Twitch extensions, and relevant `[AD DEBUG]` console messages.

## Other solutions

See the [solution list](full-list.md) for proxies, alternate players, and other tools, including [proxy buffering and downtime notes](full-list.md#proxy-issues). There is also a community list at [ScrewTwitchAds](https://github.com/zGato/ScrewTwitchAds).

## Development checks

Use Node.js 22 or 24. Install the locked test dependencies, then run the checks:

```sh
npm ci --ignore-scripts
npm test
node --test tests/release-workflow.test.js
npm run test:package
npx playwright install
npm run test:browser
```

Project checks run on Windows and Linux with both Node versions. They validate metadata, syntax, paired userscript/uBlock logic, serialized workers, and runtime regressions. Packaging writes the installable scripts and SHA-256 checksums to `release-artifact/`.

Browser tests run the scripts on offline Twitch fixtures in Chromium, Firefox, and WebKit. GitHub Actions saves reports and failure traces. Release checks test note extraction and publishing restrictions. Live ad delivery and installation through browser extensions need manual testing.

## License

Licensed under the [MIT License](LICENSE). See [CHANGELOG.md](CHANGELOG.md) for this fork's changes.
