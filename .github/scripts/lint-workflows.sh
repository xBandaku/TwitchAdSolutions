#!/usr/bin/env bash
set -euo pipefail

mkdir -p "$RUNNER_TEMP/actionlint"
gh release download v1.7.12 --repo rhysd/actionlint --pattern actionlint_1.7.12_linux_amd64.tar.gz --pattern actionlint_1.7.12_checksums.txt --dir "$RUNNER_TEMP/actionlint" --clobber
(
  cd "$RUNNER_TEMP/actionlint"
  sha256sum --check --ignore-missing actionlint_1.7.12_checksums.txt
  tar -xzf actionlint_1.7.12_linux_amd64.tar.gz
)
"$RUNNER_TEMP/actionlint/actionlint" -color "$GITHUB_WORKSPACE"/.github/workflows/*.yml
