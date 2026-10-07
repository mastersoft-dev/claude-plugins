# Changelog

All notable user-facing changes to the Timer Claude Code plugin are documented
here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to adhere to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- A timer started without a note is named and booked after its git branch
  (`feat/login-sso` books as "login sso"), and links to its own git worktree
  folder, so parallel tasks run by any orchestrator read apart. Default
  branches, or no git at all, keep the repo's name.

### Changed

- The timer panel names a timer with no note by its repo (the git remote's
  name, else the folder's) instead of "(no note)", and shows the repo's name,
  a link to its folder, in place of its full path.
- The band's ☰ button closes the timer panel when it is already open.

### Fixed

- A timer left open by a session that closed without exiting (a closed window,
  a crash) is stopped within a few minutes by any other open session, or by the
  next one to start, paused ones included, at the last moment its session was
  seen. Before, a paused one stayed open and was never booked.

## [0.1.0] — 2026-10-07

### Added

- A work timer per session: start, pause and stop it from a band above the
  prompt or with `/timer`, with an auto mode that counts only the time Claude
  works. A panel (`/timer open`) lists the day's timers of this session or of
  all sessions, to rename, continue or delete them.
- The repo's GEWEB project or customer is recognised through the `ms` CLI, and
  the day is booked on the GEWEB live timesheet in one confirmed batch, after a
  daily reminder (`reminderTime`, default 17:30). `/timer export` writes every
  session's time as CSV.
