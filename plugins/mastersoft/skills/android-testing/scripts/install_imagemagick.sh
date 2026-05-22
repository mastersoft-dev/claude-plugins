#!/usr/bin/env bash
# install_imagemagick.sh — install ImageMagick via Homebrew (or apt on Linux).
# Required for `screen_hash.sh --region` and `ring_window.sh --diff`.
# Idempotent.

set -eu

usage() {
    cat <<'EOF' >&2
Usage:
  install_imagemagick.sh

Installs ImageMagick via Homebrew (macOS) or apt-get (Debian/Ubuntu).
Falls back to clear instructions on other platforms.

Exit:
  0    already-installed or installed cleanly
  1    install failed
  127  no supported package manager
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        -h|--help) usage; exit 0 ;;
        *) echo "install_imagemagick: unknown arg: $1" >&2; usage; exit 64 ;;
    esac
done

if command -v magick >/dev/null 2>&1 || command -v convert >/dev/null 2>&1; then
    echo "install_imagemagick: already installed" >&2
    exit 0
fi

if command -v brew >/dev/null 2>&1; then
    echo "install_imagemagick: brew install imagemagick" >&2
    brew install imagemagick || { echo "install_imagemagick: brew failed" >&2; exit 1; }
    exit 0
fi

if command -v apt-get >/dev/null 2>&1; then
    echo "install_imagemagick: sudo apt-get install -y imagemagick" >&2
    sudo apt-get install -y imagemagick || { echo "install_imagemagick: apt failed" >&2; exit 1; }
    exit 0
fi

echo "install_imagemagick: no supported package manager (brew/apt). Install ImageMagick manually." >&2
exit 127
