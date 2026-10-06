# Changelog

All notable user-facing changes to the Relay Claude Code plugin are documented
here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to adhere to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `/relay` continues in a fresh session from a digest built locally, without
  calling the model on the old session, so a cold prompt cache is not paid
  again. It hands over to Claude after `/clear`, or to Codex, OpenCode or
  Gemini through herdr or Orca, and to the clipboard otherwise. Secrets in
  failed commands are redacted before the prompt leaves the session.

### Changed

- `/relay` preselects the local summary even when the cache is warm, so the
  handover is instant. The summary from the model is still offered, and the
  pane says it takes tens of seconds.

### Fixed

- `/relay` reads only the last 4 MiB of a transcript over Claude Code's 4 MiB
  read limit to find when the session last answered, instead of failing with
  "Cannot read the session".
- A cache check that fails no longer stops `/relay`: the pane opens with the
  cache state unknown and says why.
- A resumed session takes its idle time from Claude Code, so `/relay` knows
  the cache state without reading the transcript.
