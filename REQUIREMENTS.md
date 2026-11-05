# Development requirements: fresh OS setup

Start here on a new computer with no developer tools installed. You need an
internet connection, a web browser, and permission to install software. Run
commands one at a time and stop if any command fails.

This guide sets up a contributor workspace. To install the ad blocker for
normal browser use, follow [Install](README.md#install) instead.

## 1. Install the tools for your OS

### Windows

1. Install available Windows updates and restart if requested.
2. Download and run [Git for Windows](https://git-scm.com/install/windows).
   Keep the option that makes Git available from the command line and other
   software. The default editor choice does not affect the checks.
3. Open the [Node.js download page](https://nodejs.org/en/download), select
   **Node.js 24**, Windows, and your computer's architecture. Download the
   Windows installer (`.msi`) and run it. Include npm and the PATH entries.
   The optional native-module build tools are not required by this repository.
4. Install Python 3 using the [official Windows downloads](https://www.python.org/downloads/windows/).
   Follow the installer's instructions to install a Python runtime and make
   `python` available on PATH. Installing only a launcher or install manager
   is not enough: `python --version` must print a Python 3 version.
5. Close any existing terminals. Open **Windows PowerShell** from Start.

You do not need to install a separate terminal, editor, Visual Studio, Docker,
or a global npm package to run the project checks. This guide uses `npm.cmd`
and `npx.cmd` on Windows so PowerShell script policy does not block npm.

Check each tool before continuing:

```powershell
git --version
node --version
npm.cmd --version
python --version
```

Node must report `v24.x` or `v22.x`; the repository tests these two major
versions. Choose 24 for a fresh setup, even if the download page defaults to
another release. npm is included with Node.js.

If a command is not recognized, reopen PowerShell and check that the relevant
installer added its tools to PATH. If `python` opens the Microsoft Store,
complete the Python runtime installation and check Windows app execution
aliases for `python.exe`; a Store shortcut is not an installed runtime.
Do not continue until all four version checks succeed.

### macOS

1. Open **Terminal** from Applications > Utilities. Run `xcode-select --install`
   and complete Apple's Command Line Tools installer, which provides Git.
2. Download the **Node.js 24 macOS installer** (`.pkg`) from the
   [official Node.js page](https://nodejs.org/en/download) and install it with npm.
3. Download and install Python 3 from the
   [official macOS downloads](https://www.python.org/downloads/macos/).
4. Reopen Terminal and check the tools:

```sh
git --version
node --version
npm --version
python3 --version
```

Node must report `v24.x` or `v22.x`. Use `python3` for the Python checks below.

### Ubuntu / Debian Linux

Open Terminal. Install Git, Python, and the download/certificate tools first:

```sh
sudo apt-get update
sudo apt-get install -y git python3 curl ca-certificates xz-utils
```

Open the [Node.js download page](https://nodejs.org/en/download), select
**Node.js 24**, Linux, and your architecture, then follow its installation
instructions, including any prerequisites for the selected installation
method. Install npm with Node. Do not assume your distribution's default
`nodejs` package provides a version supported by this repository.

Open a new terminal and verify:

```sh
git --version
node --version
npm --version
python3 --version
```

Node must report `v24.x` or `v22.x`. Use `python3` for the Python checks below.
For another Linux distribution, use its package manager for the prerequisites
and check [Playwright's supported operating systems](https://playwright.dev/docs/intro#system-requirements)
before attempting the full browser suite.

## 2. Download the repository

In PowerShell or Terminal, move to the folder where you want to keep your
projects. Your home folder is a suitable starting location. Then run:

```sh
git clone https://github.com/xBandaku/TwitchAdSolutions.git
cd TwitchAdSolutions
```

If you already have a checkout, open a terminal in that folder instead of
cloning again. All remaining commands run from the folder containing
`package.json` and `package-lock.json`.

## 3. Install project packages and test browsers

On Windows PowerShell:

```powershell
npm.cmd ci --ignore-scripts
npx.cmd --no-install playwright install
```

On macOS:

```sh
npm ci --ignore-scripts
npx --no-install playwright install
```

On supported Ubuntu / Debian Linux, include browser system libraries. This
step may request your administrator password:

```sh
npm ci --ignore-scripts
npx --no-install playwright install --with-deps
```

`package.json` declares the development packages; `package-lock.json` records
the exact dependency tree. Keep both files together and use `npm ci` for
repeatable installs. It replaces the local `node_modules` folder with the
locked packages. No global npm packages are required.

Playwright downloads its own Chromium, Firefox, and WebKit binaries to a
per-user cache. An ordinary browser installation does not replace these
binaries. Rerun the Playwright install command after updating Playwright.

Python scripts use only the standard library. There are no pip packages to
install and no Python `requirements.txt` is needed. No database, account,
API key, or environment-variable file is required for the offline checks.

## 4. Verify the installation

On Windows PowerShell:

```powershell
npm.cmd run lint
npm.cmd test
npm.cmd run test:package
npm.cmd run test:browser
python -m compileall -q .github
python -m unittest discover -s .github/scripts -p "test_*.py" -v
```

On macOS / Linux:

```sh
npm run lint
npm test
npm run test:package
npm run test:browser
python3 -m compileall -q .github
python3 -m unittest discover -s .github/scripts -p "test_*.py" -v
```

A complete setup passes every applicable command. Packaging creates ignored
output in `release-artifact/`. Browser checks use offline fixtures and create
ignored reports in `playwright-report/` and `test-results/`. Windows WebKit
skips PCM media cases; Linux CI covers them. These checks do not verify live
Twitch ads or extension installation.

If a browser fails to launch, the browser suite has not passed. Keep the exact
launch error and inspect the HTML report in `playwright-report/`. If the error
says the Playwright executable is missing, repeat the browser install step.
A Windows side-by-side assembly error requires investigating the named browser
runtime or OS component; installing npm packages again does not establish that
it is fixed.

Optional benchmark, capture, regression, and CI workflow commands are described
in [Development](README.md#development) and the CI workflows. Running these
local checks does not publish or deploy anything.
