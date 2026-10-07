# timer: work timer for Claude Code

A Claude Code plugin that tracks working time per Claude Code session, under any orchestrator or none, and hands it to Claude to book on a timesheet.

## What it does

- **Timer per session**: start, pause, resume and stop from the band above the prompt or with `/timer`. The status line shows the running time.
- **Auto mode**: the timer runs only while Claude is working on a turn, for long background tasks.
- **Session end**: closing Claude Code stops the timer; after `/clear` the band asks whether to keep it running or stop it.
- **Panel** (`/timer open` or ☰): today's timers for this session or for all sessions, with editable notes. You can continue or delete a timer from there.
- **Names from git**: a timer with no note is named after its branch (`feat/login-sso` → "login sso") and links to its worktree folder; on a default branch it keeps the repo's name.
- **Booking by Claude**: the plugin gives Claude two tools. `mcp__timer__entries` lists the time per timer and day (minutes, the subagents' share of them, start, title, repo, git remote, branch, folder, state); `mcp__timer__mark_booked` records a day as booked so it is not offered again. From the reminder time (default 17:30, Italian time) the band shows how many timers wait to be booked.
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

## Development

```
claude plugin validate --strict plugins/timer
claude plugin test plugins/timer
```
