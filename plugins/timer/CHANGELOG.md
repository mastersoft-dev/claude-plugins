# Changelog

All notable user-facing changes to the Timer Claude Code plugin are documented
here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to adhere to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Copy list (`c`) in the To book tab puts its lines on the clipboard,
  tab-separated, to paste into a spreadsheet or a timesheet by hand.
- The `sound` setting (`off` by default) plays a short chime at the daily
  booking reminder and when the band asks about time away.
- One-key shortcuts while the band or the panel has the focus (ctrl+x tab, or
  a click): on the band `s` start, `p` pause or resume, `x` stop, `a` auto,
  `o` the panel, `k`/`l`/`t` for the away question; in the panel `1`-`4` the
  tabs and `n` Add time.
- A Week tab in the panel: a bar for each of the last seven days against the
  `targetHours` setting (8 by default), the days with timers still to book,
  and the week's time by repo and by tag.
- The entries tool takes `includeSummary`: the lines of this session's timers
  then carry what the session did, written from its own transcript by one
  extra model call, for the booking's description.
- Each prompt you send tells Claude, in one line beside it, how long this
  session's timer has run and on what, and how many timers wait to be
  booked. The `tellClaude` setting (`on` by default) turns it off.
- After `/relay` continues the work in a fresh conversation, the timer keeps
  running there with no question: it becomes the new conversation's timer.
- Every timer in the panel can be selected and edited, those of other
  sessions in the All tab and every day of the To book tab included: note,
  tags, From and To, continue and delete. A timer still open in another
  session can't be deleted or continued from here.
- The panel's "+ Add time" form adds time worked with no timer running: a
  day of the last week, from, to, note and tags.
- A timer selected in the panel has From and To boxes that move its start
  and end today.
- The panel marks a timer that ran alongside others that day with ⚠ and the
  time they shared.
- With `roundTo` set, the panel's To book tab shows each day's minutes as
  they will be booked, with the tracked ones beside them.
- The daily booking reminder also offers "Book my unbooked timers" in the
  empty prompt box, for Tab to take.
- The `autoGraceMinutes` setting (0 by default) keeps an auto-mode timer
  running that many minutes after Claude's turn ends, so reading the answer
  and typing the next prompt count, and a turn started within them leaves no
  gap.
- The `autoStart` setting (`off` by default) can start a timer by itself:
  `session` when a session starts with none open, `prompt` at any prompt sent
  with none open.
- What Claude's work costs while a timer runs is recorded per day: the
  entries tool lists it as `costUsd` and the panel shows it beside the repo.
- The entries tool takes `includeCommits`: each line then lists the commits
  you made in its folder while the timer ran that day, for Claude to write
  the booking's description from.
- The `roundTo` setting (0, off, by default) rounds each timer's minutes of a
  day to the nearest multiple when Claude books them, never below one; the
  entries tool then lists the minutes before rounding as `exactMinutes`.
- Two tools for Claude: `mcp__timer__add_entry` adds a timer for time worked
  with no timer running ("I forgot to start it at 9"), and
  `mcp__timer__edit_entry` changes a timer's start or end on a day, its note
  or its tags. A day already booked keeps its times.
- Tags on a timer (`/timer tag review meeting`, or the Tags box of a timer
  selected in the panel), shown in the panel, listed by the entries tool and
  written to a new last `tags` column of the CSV export.
- The `branchChange` setting (`keep` by default) can be set to `split`: when
  a running timer's worktree moves to another branch, the timer stops and a
  new one, named after the new branch, starts, so each branch is booked apart.
- Time away from a running timer, no typing, prompt or press for
  `idleMinutes` (default 15) while Claude isn't working, or the computer
  asleep, is noticed. When you're back the band asks whether to keep it,
  leave it out or move it to a timer of its own; the `awayTime` setting
  (`ask` by default) can leave it out without asking, or keep counting it as
  before. A session closed while you're still away stops its timer when you
  left.
- A "To book" tab in the timer panel lists every stopped timer's day not
  booked yet, the days before today included.
- The entries tool names, on each line, the other timers that ran at the same
  time that day and the minutes they share, so Claude doesn't book the same
  hours twice without asking.

### Changed

- Today's totals (`/timer status`, the panel) count time that timers in
  several sessions ran at once only once. The `parallelTime` setting
  (`wall-clock` by default) can switch back to `summed`, which adds every
  timer's own time.
- The 30-second refresh reads only the open timers, and the count of timers
  to book at most every five minutes, instead of every timer the store keeps.

## [1.0.0] — 2026-10-08

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
- Booked timers are dropped once they are older than `retentionDays` (default
  90), so the store stays small; time not yet booked is kept however old.
- The time subagents work while the timer runs is recorded per day and listed
  as `agentMinutes`. The `agentTime` setting (`wall-clock` by default) can
  switch to `summed`, which adds it to the timer's time and the booked minutes.
- In an Orca worktree a timer with no note is named after the worktree's
  linked issue, else the name given to the worktree, and the entries tool
  lists the worktree as the timer's `task`. Outside Orca nothing changes.

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
