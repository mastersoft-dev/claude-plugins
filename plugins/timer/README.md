# timer: work timer for Claude Code, booked on GEWEB

A Claude Code plugin that tracks working time per Claude Code session and books it on the Mastersoft GEWEB live timesheet in one batch at the end of the day.

## What it does

- **Timer per session**: start, pause, resume and stop from the band above the prompt or with `/timer`. The status line shows the running time.
- **Auto mode**: the timer runs only while Claude is working on a turn, for long background tasks.
- **Panel** (`/timer open` or ☰): today's timers for this session or for all sessions, with editable notes. You can continue or delete a timer from there.
- **Names from git**: a timer with no note is named and booked after its branch (`feat/login-sso` → "login sso") and links to its worktree folder; on a default branch it keeps the repo's name.
- **Customer recognition**: the repo's git remote is looked up in GEWEB.
  - Linked to a project (`hr/GitRepo`): the time is booked on that project.
  - Installed at a customer but with no project (`hr/Istanza`): it is listed so the user can pick a project with `/timer project <search>`.
  - Neither: the time stays local and is never booked.
- **End-of-day booking**: from the reminder time (default 17:30, Italian time) the band offers **Book all**. The Book pane lists every pending slot with an editable description and minutes. Nothing is sent until the user presses Confirm.
- **Export**: `/timer export [file.csv]` writes every session's time as CSV.

## Requirements

- Claude Code with plugin support. The plugin is a hooks module (`hooks/register.tsx`), with no build step.
- The `ms` CLI (mastersoft-cli) on `PATH`, logged in with `ms login` (Microsoft SSO). Each user books with their own GEWEB account.

## What it writes to GEWEB

Only after the user confirms, and only with that user's own token, it calls these for each slot:

1. `POST api/hr/attivita-temporale/` with `descrizione`, `progetto`, `data` and `ora`
2. `POST api/hr/attivita-temporale/<id>/aggiungi_tempo/` with `minuti` and `data`
3. `POST api/hr/attivita-temporale/<id>/set_stato/` with `stato=completata`

GEWEB's usual "genera timesheet" then turns these activities into timesheet rows (`hr/lavoro`). Reads are the `api/autocomplete/hr/{GitRepo,Istanza,Progetto}/` lookups. A day is claimed locally before the first write, so a retry or a second session never books it twice.

Local data (timers, the project chosen for each repo) lives in the plugin's own Claude Code store, on the user's machine.

## Install

Mastersoft team members already have the `mastersoft` marketplace from the org-managed settings:

```text
/plugin install timer@mastersoft
```

The changes are in [CHANGELOG.md](CHANGELOG.md).

## Settings

| Option | Default | Meaning |
|---|---|---|
| `reminderTime` | `17:30` | HH:mm, Italian time, when the band offers Book all and shows the daily reminder |

## Development

```
claude plugin validate --strict plugins/timer
claude plugin test plugins/timer
```
