# timer: work timer for Claude Code

A Claude Code plugin that tracks working time per Claude Code session, under any orchestrator or none, and hands it to Claude to book on a timesheet.

## What it does

- **Timer per session**: start, pause, resume and stop from the band above the prompt or with `/timer`. The status line shows the running time.
- **Keys**: while the band or the panel has the focus (ctrl+x tab, or a click), `s` starts, `p` pauses or resumes, `x` stops, `a` toggles auto mode and `o` opens the panel; in the panel `1`-`4` pick the tab and `n` opens Add time.
- **Auto mode**: the timer runs only while Claude is working on a turn, for long background tasks; with `autoGraceMinutes` also that many minutes after each turn.
- **Time away**: with no typing, prompt or press for 15 minutes while Claude isn't working, or with the computer asleep, the timer notices you're away. When you're back the band asks whether to keep that time, leave it out, or move it to a timer of its own (the `awayTime` and `idleMinutes` settings).
- **Session end**: closing Claude Code stops the timer, at the moment you left when you're still away; after `/clear` the band asks whether to keep it running or stop it, and after `/relay` (the relay plugin) continues the work in a fresh conversation, the timer goes on there by itself.
- **Panel** (`/timer open` or ☰): today's timers for this session or for all sessions, with editable notes, tags and From/To times, a "To book" tab with every day not booked yet (Copy list puts it on the clipboard, tab-separated), and a Week tab with a bar per day against your daily target and the time by repo and tag. A timer that ran alongside others is marked ⚠ with the time they shared. Any timer can be selected there, in the All and To book tabs too, to change it, continue it or delete it (a timer still open in another session is paused, stopped or deleted there), and "+ Add time" adds time you worked with no timer running (a day of the last week, from, to, note and tags).
- **Tags**: `/timer tag review meeting` labels the running timer (`/timer tag` alone clears them), and the panel has a Tags box for a selected timer. The panel, the entries tool and the CSV export list them.
- **Names from git**: a timer with no note is named after its branch (`feat/login-sso` → "login sso") and links to its worktree folder; on a default branch it keeps the repo's name.
- **Orca**: in a worktree managed by Orca, a timer with no note is named after the worktree's linked issue (`#131 SSO login`), else a name you gave the worktree, and the entries tool hands Claude the worktree as the timer's `task`, so its timers can be booked together. It asks `orca worktree current --json` once per timer; outside Orca nothing changes.
- **Booking by Claude**: the plugin gives Claude tools. `mcp__timer__entries` lists the time per timer and day (minutes, the subagents' share of them, start, title, repo, git remote, branch, folder, state, and the other timers that ran at the same time); `mcp__timer__mark_booked` records a day as booked so it is not offered again. Asked with `includeCommits`, the entries tool also lists the commits you made in each timer's folder while it ran, so Claude can write the booking's description from them; with `includeSummary` it also gets what this session did, written from its own transcript. From the reminder time (default 17:30, Italian time) the band shows how many timers wait to be booked, and the empty prompt box offers "Book my unbooked timers" once a day, for Tab to take.
- **Fixing time with Claude**: `mcp__timer__add_entry` adds a timer for time you worked without one running, and `mcp__timer__edit_entry` moves a timer's start or end on a day, or changes its note or tags; ask Claude in your own words ("I worked on the release notes from 8 to 9:30, add it"). A day already booked keeps its times.
- **Cost**: what Claude's work costs while a timer runs (the session's cost, as `/cost` counts it) is put on that timer by day. The panel shows it beside the repo, and the entries tool lists it as `costUsd`.
- **Claude knows**: each prompt you send carries one line for Claude on this session's timer and the timers waiting to be booked, so "how long have I worked on this?" needs no tool call (`tellClaude: off` stops it).
- **Export**: `/timer export [file.csv]` writes every session's time as CSV.

## Booking on GEWEB

At Mastersoft, ask Claude to book the day ("book today's timer on GEWEB"). The `ms` skill of [mastersoft-cli](https://gitlab.sermix.com/mastersoft/mastersoft-cli) reads the timer's entries, matches each repo to its GEWEB project, checks what is already on the day's live timesheet, shows the plan, and books it with the `ms` CLI after you confirm. It needs `ms` on `PATH` and logged in.

## Requirements

Claude Code with plugin support. The plugin is a hooks module (`hooks/register.tsx`), with no build step. Local data (the timers) lives in the plugin's own Claude Code store, on the user's machine.

## Install

Mastersoft team members already have the `mastersoft` marketplace from the org-managed settings:

```text
/plugin install timer@mastersoft
```

The changes are in [CHANGELOG.md](CHANGELOG.md).

## Settings

| Option | Default | Meaning |
|---|---|---|
| `reminderTime` | `17:30` | HH:mm, Italian time, from when the band shows the timers still to book and reminds you once a day |
| `retentionDays` | `90` | Days a booked timer is kept after it stopped, then dropped from the panel and the export; time not yet booked is kept however old |
| `agentTime` | `wall-clock` | `wall-clock` counts the timer's own time. `summed` adds the run of every subagent that ends while the timer runs, so three parallel subagents count three times; the CSV export keeps the timer's own segments |
| `sound` | `off` | `on` plays a short chime at the daily booking reminder and when the band asks about time away, where Claude Code has a player (macOS; a Windows or Linux terminal has none) |
| `tellClaude` | `on` | `on` adds one line beside each prompt you send on this session's timer and the timers waiting to be booked; `off` leaves prompts as typed |
| `autoStart` | `off` | Starts a timer with no note by itself: `session` when a session starts with none open, `prompt` at any prompt sent with none open (after a stop too). `off` starts timers only when you ask |
| `autoGraceMinutes` | `0` | In auto mode, minutes the timer keeps running after Claude's turn ends (reading the answer, typing the next prompt); a turn started within them leaves no gap. `0` pauses it as the turn ends |
| `awayTime` | `ask` | What happens to the time a running timer counts while you're away: `ask` when you're back (keep it, leave it out, or move it to a timer of its own), `discard` it, or `keep` counting it |
| `idleMinutes` | `15` | Minutes with no typing, prompt or press, and Claude not working, before you count as away; `0` counts only a sleeping computer |
| `branchChange` | `keep` | When a running timer's worktree moves to another branch (checked at each prompt and at the end of Claude's turn): `keep` counting on the same timer, or `split`, which stops it and starts a timer named after the new branch |
| `roundTo` | `0` | Minutes to round each timer's day to when Claude books it (to the nearest multiple, never below one; 15 books 52 minutes as 45 and 53 as 60). `0` books whole minutes. The panel and the CSV export keep the time as tracked |
| `targetHours` | `8` | The hours a working day aims at: the Week tab draws each day's bar against it (`0` draws against 8 hours with no target shown) |
| `parallelTime` | `wall-clock` | How today's totals in `/timer status` and the panel count timers that ran at the same time in several sessions: `wall-clock` counts that time once, `summed` adds every timer's own time. Booking always lists each timer's own minutes, with the timers it overlapped |

## Development

```
claude plugin validate --strict plugins/timer
claude plugin test plugins/timer
```
