# timer: work timer for Claude Code

A Claude Code plugin that tracks working time per Claude Code session, under any orchestrator or none, and hands it to Claude to book on a timesheet.

## What it does

- **Timer per session**: start, pause, resume and stop from the band above the prompt or with `/timer`. The status line shows the running time.
- **Auto mode**: the timer runs only while Claude is working on a turn, for long background tasks.
- **Time away**: with no typing, prompt or press for 15 minutes while Claude isn't working, or with the computer asleep, the timer notices you're away. When you're back the band asks whether to keep that time, leave it out, or move it to a timer of its own (the `awayTime` and `idleMinutes` settings).
- **Session end**: closing Claude Code stops the timer, at the moment you left when you're still away; after `/clear` the band asks whether to keep it running or stop it.
- **Panel** (`/timer open` or ☰): today's timers for this session or for all sessions, with editable notes, and a "To book" tab with every day not booked yet. You can continue or delete a timer from there.
- **Names from git**: a timer with no note is named after its branch (`feat/login-sso` → "login sso") and links to its worktree folder; on a default branch it keeps the repo's name.
- **Orca**: in a worktree managed by Orca, a timer with no note is named after the worktree's linked issue (`#131 SSO login`), else a name you gave the worktree, and the entries tool hands Claude the worktree as the timer's `task`, so its timers can be booked together. It asks `orca worktree current --json` once per timer; outside Orca nothing changes.
- **Booking by Claude**: the plugin gives Claude two tools. `mcp__timer__entries` lists the time per timer and day (minutes, the subagents' share of them, start, title, repo, git remote, branch, folder, state, and the other timers that ran at the same time); `mcp__timer__mark_booked` records a day as booked so it is not offered again. From the reminder time (default 17:30, Italian time) the band shows how many timers wait to be booked.
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
| `awayTime` | `ask` | What happens to the time a running timer counts while you're away: `ask` when you're back (keep it, leave it out, or move it to a timer of its own), `discard` it, or `keep` counting it |
| `idleMinutes` | `15` | Minutes with no typing, prompt or press, and Claude not working, before you count as away; `0` counts only a sleeping computer |
| `branchChange` | `keep` | When a running timer's worktree moves to another branch (checked at each prompt and at the end of Claude's turn): `keep` counting on the same timer, or `split`, which stops it and starts a timer named after the new branch |
| `parallelTime` | `wall-clock` | How today's totals in `/timer status` and the panel count timers that ran at the same time in several sessions: `wall-clock` counts that time once, `summed` adds every timer's own time. Booking always lists each timer's own minutes, with the timers it overlapped |

## Development

```
claude plugin validate --strict plugins/timer
claude plugin test plugins/timer
```
