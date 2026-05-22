#!/usr/bin/env bash
# install_maestro.sh — install Maestro (cross-platform mobile flow runner)
# via Homebrew. Idempotent.
#
# Maestro is a single Java binary, ~50MB. We use brew exclusively to avoid
# piping unsigned shell from a remote URL into bash. If you don't have
# Homebrew, install it first (https://brew.sh) or download Maestro manually
# from https://maestro.mobile.dev.

set -eu

usage() {
    cat <<'EOF' >&2
Usage:
  install_maestro.sh

Installs Maestro via `brew install maestro`. Requires Homebrew.

Exit:
  0    already-installed or installed cleanly
  1    install failed
  127  brew not on PATH
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        -h|--help) usage; exit 0 ;;
        *) echo "install_maestro: unknown arg: $1" >&2; usage; exit 64 ;;
    esac
done

if command -v maestro >/dev/null 2>&1; then
    echo "install_maestro: already installed at $(command -v maestro)" >&2
    exit 0
fi

if ! command -v brew >/dev/null 2>&1; then
    cat <<'EOF' >&2
install_maestro: Homebrew not found. Install brew first:
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
Or download Maestro manually from https://maestro.mobile.dev and place the
binary on your PATH.
EOF
    exit 127
fi

# Use the mobile-dev-inc tap. The bare `brew install maestro` formula was
# claimed by an unrelated Electron app; the mobile flow runner lives under
# the project's official tap.
echo "install_maestro: brew tap mobile-dev-inc/tap" >&2
brew tap mobile-dev-inc/tap 2>&1 | tail -5 || {
    echo "install_maestro: 'brew tap mobile-dev-inc/tap' failed" >&2
    exit 1
}

echo "install_maestro: brew install mobile-dev-inc/tap/maestro (this can take a minute)" >&2
brew install mobile-dev-inc/tap/maestro || {
    echo "install_maestro: 'brew install mobile-dev-inc/tap/maestro' failed" >&2
    exit 1
}

if command -v maestro >/dev/null 2>&1; then
    echo "install_maestro: installed at $(command -v maestro)" >&2
    exit 0
fi
# Cellar fallback when the symlink is masked by an unrelated cask of the
# same name (the bare `maestro` cask is an Electron app, not the flow runner).
for cand in /opt/homebrew/Cellar/maestro/*/bin/maestro /usr/local/Cellar/maestro/*/bin/maestro; do
    if [[ -x "$cand" ]]; then
        echo "install_maestro: installed at $cand (symlink masked by another cask; run_maestro.sh and check_deps.sh handle this automatically)" >&2
        exit 0
    fi
done
echo "install_maestro: brew reported success but 'maestro' not findable" >&2
exit 1
