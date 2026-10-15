<!-- markdownlint-disable MD033 MD041 -->
<div align="center">

# TwitchAdSolutions

[![Version](https://img.shields.io/github/v/release/xBandaku/TwitchAdSolutions?color=%230567ff&label=Latest%20Release&style=for-the-badge)](https://github.com/xBandaku/TwitchAdSolutions/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/xBandaku/TwitchAdSolutions/total?label=Total%20Downloads&style=for-the-badge)](https://github.com/xBandaku/TwitchAdSolutions/releases)
[![License](https://img.shields.io/github/license/xBandaku/TwitchAdSolutions?style=for-the-badge)](LICENSE)

</div>
<!-- markdownlint-enable MD033 MD041 -->

Scripts for blocking Twitch ads with Violentmonkey or uBlock Origin. Start with `vaft` using the installation steps below.

Fork of [ryanbr/TwitchAdSolutions](https://github.com/ryanbr/TwitchAdSolutions), originally based on [pixeltris/TwitchAdSolutions](https://github.com/pixeltris/TwitchAdSolutions) (archived).

**Don't combine Twitch specific ad blockers.**

## Contents

- [1. Install vaft (Violentmonkey)](#1-install-vaft-violentmonkey)
- [2. Choose a script](#2-choose-a-script)
- [3. Install with uBlock Origin](#3-install-with-ublock-origin)
- [Configuration](#configuration)
- [Known extension conflicts](#known-extension-conflicts)
- [Troubleshooting](#troubleshooting)
- [Other solutions](#other-solutions)
- [License](#license)

## 1. Install vaft (Violentmonkey)

1. Install [Violentmonkey](https://violentmonkey.github.io/) in your browser.
2. Open [vaft v68.5.8](https://github.com/xBandaku/TwitchAdSolutions/releases/download/v68.5.8/vaft.user.js) and confirm installation in Violentmonkey. If your browser downloads the file, import `vaft.user.js` through Violentmonkey's dashboard.
3. Reload any open Twitch stream.

The [release notes](https://github.com/xBandaku/TwitchAdSolutions/releases/tag/v68.5.8) list the fixes and testing limits. For future stable updates, check the [latest release](https://github.com/xBandaku/TwitchAdSolutions/releases/latest).

[Tampermonkey](https://www.tampermonkey.net/) and [Userscripts for Safari](https://apps.apple.com/us/app/userscripts/id1463298887) are other supported managers. Greasemonkey doesn't work with the scripts.

On browsers that require userscript permissions, enable them in the extension settings. See [troubleshooting](issues.md) for details.

## 2. Choose a script

`vaft` is recommended for this fork. See [other solutions](#other-solutions) for alternatives.

- vaft - [userscript](https://github.com/xBandaku/TwitchAdSolutions/raw/master/vaft/vaft.user.js) / [ublock](https://raw.githubusercontent.com/xBandaku/TwitchAdSolutions/master/vaft/vaft-ublock-origin.js) / [ublock (permalink)](https://raw.githubusercontent.com/xBandaku/TwitchAdSolutions/v68.5.8/vaft/vaft-ublock-origin.js)
  - Attempts to get a clean stream as fast as it can
  - If it fails to get a clean stream it removes ad segments (no playback until ad-free stream is found)
- video-swap-new - [userscript](https://github.com/xBandaku/TwitchAdSolutions/raw/master/video-swap-new/video-swap-new.user.js) / [ublock](https://raw.githubusercontent.com/xBandaku/TwitchAdSolutions/master/video-swap-new/video-swap-new-ublock-origin.js) / [ublock (permalink)](https://raw.githubusercontent.com/xBandaku/TwitchAdSolutions/v68.5.8/video-swap-new/video-swap-new-ublock-origin.js)
  - Attempts to get a clean stream
  - If it fails to get a clean stream it removes ad segments (no playback until ad-free stream is found)
  - Not recommended, `vaft` is a better script

## 3. Install with uBlock Origin

- Navigate to the uBlock Origin Dashboard (the extension options)
- Under the `My filters` tab add `twitch.tv##+js(twitch-videoad)`.
- Under the `Settings` tab, enable `I am an advanced user`, then click the cog that appears. Modify the value of `userResourcesLocation` from `unset` to the full url of the solution you wish to use (if a url is already in use, add a space after the existing url). e.g. `userResourcesLocation https://raw.githubusercontent.com/xBandaku/TwitchAdSolutions/master/vaft/vaft-ublock-origin.js`
- To ensure uBlock Origin loads the script I recommend that you disable/enable the uBlock Origin extension (or restart your browser).

To stop using a script remove the filter and make the url `unset`.

*For the sake of security it's recommended to use a permalink when using uBlock Origin (permalinks do not auto update).*

*The scripts __may randomly stop being applied by uBlock Origin__ for unknown reasons ([#200](https://github.com/pixeltris/TwitchAdSolutions/issues/200)). It's recommended to use the userscript versions instead.*

## Configuration

The scripts support runtime configuration via `localStorage`. Set values in the browser console and refresh the page.

**`twitchAdSolutions_reloadPlayerAfterAd`** (default: `true`)
- `true` - full player reload after ads (slower, more reliable)
- `false` - pause/play after ads (faster, less reliable)
- Not set - uses default (`true`)

**`twitchAdSolutions_playerType`** (default: `popout`)
- Changes the player type used for access token requests
- `popout` - popout player context, tends to receive fewer ads (default)
- `embed` - embedded player context, used for third-party sites
- `site` - normal site player, standard Twitch experience (most ads)
- `autoplay` - autoplay context, lower quality (360p)
- Not set - uses default (`popout`)

**`twitchAdSolutions_hideAdOverlay`** (default: not set)
- `true` - hide the "Blocking ads" banner overlay on the video player
- Not set - banner is visible during ad blocking (default)

**`twitchAdSolutions_pinBackupPlayerType`** (default: `true` for vaft, `false` for video-swap-new)

- `true` - remember which backup player type worked and try it first on next ad break (saves backup search time)
- `false` - disable optional backup pinning

Vaft also promotes successful Source-quality types independently of this setting and never pins `autoplay` here. Its low-quality backup options can still select a 360p stream.

**`twitchAdSolutions_reloadCooldownSeconds`** (default: `30`)
- Minimum seconds between player reloads after ad breaks
- Prevents CSAI (client-side ad insertion) cascades where a reload triggers Twitch to serve another ad
- Set to `0` to disable cooldown

**`twitchAdSolutions_disableReloadCap`** (default: not set)
- `true` - buffer monitor reloads unlimited times (pre-v47 behavior, risk of reload loops)
- Not set - buffer monitor reloads at most once per recovery window (default)
- Only enable if you're seeing stuck playback that a single reload doesn't fix

**`twitchAdSolutions_preferLowQualityBackup`** (default: `true`, vaft only)
- Hybrid safety net for SSAI-heavy ad breaks. Adds `autoplay` (360p) as a last-resort backup when all Source types (site/popout/mobile_web/embed) are ad-laden. Also enables the sticky escape hatch (~8s stuck → fall through to backup search) when `twitchAdSolutions_backupSwapFirst=false`.
- Set to `false` to disable the autoplay fallback and escape hatch
- **Quality caveat**: autoplay only commits when every Source backup is also ad-laden. The 360p hit is the tradeoff for avoiding long freezes on SSAI-heavy channels

**`twitchAdSolutions_backupSwapFirst`** (default: `true`, vaft only)
- **Default ad-blocking path** (as of v63.0.0). On ad detect, immediately swap to a backup player-type m3u8 (site → popout → mobile_web → embed, first clean wins). Avoids the MediaSource mixing produced by the legacy strip+BLANK_MP4+recovery path.
- Set to `false` to revert to the legacy sticky CSAI strip-first path. Use this if you're on a channel/network where backup fetches are unreliable and stripping native is preferable.
- **Bandwidth tradeoff**: extra token fetch on every ad break (~400ms first time per session, much less after `BackupEncodingsM3U8Cache` warms up).

```js
// Faster post-ad transition
localStorage.setItem('twitchAdSolutions_reloadPlayerAfterAd', 'false');

// Change player type
localStorage.setItem('twitchAdSolutions_playerType', 'embed');

// Hide ad blocking banner
localStorage.setItem('twitchAdSolutions_hideAdOverlay', 'true');

// Restore defaults
localStorage.removeItem('twitchAdSolutions_reloadPlayerAfterAd');
localStorage.removeItem('twitchAdSolutions_playerType');
localStorage.removeItem('twitchAdSolutions_hideAdOverlay');
localStorage.removeItem('twitchAdSolutions_pinBackupPlayerType');
localStorage.removeItem('twitchAdSolutions_reloadCooldownSeconds');
localStorage.removeItem('twitchAdSolutions_disableReloadCap');
localStorage.removeItem('twitchAdSolutions_preferLowQualityBackup');
localStorage.removeItem('twitchAdSolutions_backupSwapFirst');
```

## Known extension conflicts

- **7TV**: may cause black screen / infinite buffering ([#17](https://github.com/ryanbr/TwitchAdSolutions/issues/17))
- **TwitchNoSub**: handled automatically via workerStringReinsert, but older versions may conflict
- **TTV-AB**: running both simultaneously may cause duplicate ad blocking and errors. Use one or the other.
- **Purple AdBlock**: may conflict if both are active. Disable one.
- **AdGuard Extra**: operates at a different layer, can be used alongside without conflict

## Troubleshooting

If the script doesn't work or you're experiencing freezing / buffering issues see [issues.md](issues.md)

## Other solutions

Proxies are the most reliable way of avoiding ads ([buffering / downtime info](full-list.md#proxy-issues)).

- `TTV LOL PRO` - [chrome](https://chrome.google.com/webstore/detail/ttv-lol-pro/bpaoeijjlplfjbagceilcgbkcdjbomjd) / [firefox](https://addons.mozilla.org/addon/ttv-lol-pro/) / [code](https://github.com/younesaassila/ttv-lol-pro)

Alternatively:

- `Twitch Turbo` - https://www.twitch.tv/turbo
- `Alternate Player for Twitch.tv` - [chrome](https://chrome.google.com/webstore/detail/alternate-player-for-twit/bhplkbgoehhhddaoolmakpocnenplmhf) / [firefox](https://addons.mozilla.org/en-US/firefox/addon/twitch_5/)
- `AdGuard Extra` - [chrome](https://chrome.google.com/webstore/detail/adguard-extra-beta/mglpocjcjbekdckiahfhagndealpkpbj) / [firefox](https://github.com/AdguardTeam/AdGuardExtra/#firefox) / [userscript](https://userscripts.adtidy.org/release/adguard-extra/1.0/adguard-extra.user.js)
- [vaft](#1-install-vaft-violentmonkey)

[Read this for a full list and descriptions.](full-list.md)

[Also see this list maintained by @zGato.](https://github.com/zGato/ScrewTwitchAds)

## License

Licensed under the [MIT License](LICENSE). See [CHANGELOG.md](CHANGELOG.md) for this fork's changes.
