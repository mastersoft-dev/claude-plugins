# Changelog

All notable user-facing changes to the Timer Claude Code plugin are documented
here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to adhere to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- A work timer per session: start, pause and stop it from a band above the
  prompt or with `/timer`, with an auto mode that counts only the time Claude
  works. A panel (`/timer open`) lists the day's timers of this session or of
  all sessions, to rename, continue or delete them.
- The repo's GEWEB project or customer is recognised through the `ms` CLI, and
  the day is booked on the GEWEB live timesheet in one confirmed batch, after a
  daily reminder (`reminderTime`, default 17:30). `/timer export` writes every
  session's time as CSV.
