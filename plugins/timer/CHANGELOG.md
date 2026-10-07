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
- After `/clear` the band asks whether to keep the timer running or stop it.
  Keep running makes it the new conversation's timer, so it stays in "This
  session" and can be selected there.
- Two tools for Claude: `mcp__timer__entries` lists the tracked time per timer
  and day, and `mcp__timer__mark_booked` records a day as booked. Booking on
  GEWEB is now a request to Claude, which the `ms` skill handles.

### Removed

- Booking on GEWEB from the timer: the Book pane, Book all, `/timer book`,
  `/timer project` and the GEWEB project lookup. The timer no longer needs the
  `ms` CLI. The CSV export loses its `project` column; `activity` is now
  `booked`.

### Changed

- The timer panel names a timer with no note by its repo (the git remote's
  name, else the folder's) instead of "(no note)", and shows the repo's name,
  a link to its folder, in place of its full path.
- The band's ☰ button closes the timer panel when it is already open.

### Fixed

- A timer left open by a session that closed without exiting (a closed window,
  a crash) is stopped within a few minutes by any other open session, or a
  minute after the next one starts, paused ones included, at the last moment
  its session was seen. Before, a paused one stayed open and was never booked.
- Starting a session or a timer right after the computer wakes from sleep no
  longer stops the timers of the other open sessions.
- The 30-second refresh no longer undoes a pause, a stop or a note made while
  it runs: in auto mode a turn's end could be lost and idle time counted.
- Time past midnight (Italian time, clock changes included) is booked and
  shown on the day it ran: before, a night's whole run went on the day it
  started, which GEWEB refused, and the next morning's panel left it out.

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
