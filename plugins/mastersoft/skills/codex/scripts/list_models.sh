#!/usr/bin/env bash
set -euo pipefail

CACHE="${HOME}/.codex/models_cache.json"

if [[ ! -f "$CACHE" ]]; then
  echo "Models cache not found. Run codex once to populate it."
  exit 0
fi

echo "| Model | Description | Reasoning Levels | Visibility |"
echo "|-------|-------------|------------------|------------|"

awk '
  /"slug":/ {
    if (slug != "") {
      sub(/, $/, "", efforts)
      printf "| `%s` | %s | %s | %s |\n", slug, desc, efforts, vis
    }
    gsub(/.*"slug": *"|",?$/, ""); slug = $0
    desc = ""; vis = ""; efforts = ""; got_desc = 0
  }
  /"description":/ && !got_desc {
    gsub(/.*"description": *"|",?$/, ""); desc = substr($0, 1, 70); got_desc = 1
  }
  /"visibility":/  { gsub(/.*"visibility": *"|",?$/,  ""); vis = $0 }
  /"effort":/      { gsub(/.*"effort": *"|",?$/,      ""); efforts = efforts $0 ", " }
  END {
    if (slug != "") {
      sub(/, $/, "", efforts)
      printf "| `%s` | %s | %s | %s |\n", slug, desc, efforts, vis
    }
  }
' "$CACHE"
