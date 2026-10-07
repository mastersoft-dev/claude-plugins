---
name: ms
description: Query and operate Mastersoft's internal services through the `ms` command-line client — Presente (attendance, clockings/timbrature, employees, leave and absences, who is in the office, monthly closing, guests, company cars, meeting rooms) and GEWEB (Mastersoft's own CRM/ERP: customers/anagrafiche, contacts, contracts and contract lines, licenses, support tickets, timesheets/lavori, projects, quotes/preventivi, articles, customer servers/domains/backups, Microsoft 365 users). Use this skill whenever the user asks about data that lives in Presente or GEWEB, even if they don't name the CLI — e.g. "chi è in ufficio oggi", "quante ore ha fatto Rossi a settembre", "timbrature mancanti", "ticket aperti per Acme", "contratti in scadenza", "ore lavorate sul progetto X", "licenze M365 del cliente", "backup falliti", "preventivi di questo mese" — or wants to book the Claude Code timer's tracked time on GEWEB ("book the timer", "segna le ore del timer"), log in, create/update records, or script against those APIs.
allowed-tools: Bash(ms --version), Bash(ms skill:*), PowerShell(ms --version), PowerShell(ms skill *)
---

# ms

The instructions for Mastersoft's `ms` CLI ship inside the `ms` binary, so they always match the installed version. This skill only loads them.

1. Run `ms --version`. If the command is not found, `ms` is not installed: tell the user to download it from https://gitlab.sermix.com/mastersoft/mastersoft-cli/-/releases (`ms-windows-x86_64.exe` or `ms-linux-x86_64`, renamed to `ms` and put on the `PATH`), or on macOS to run `cargo install --git https://gitlab.sermix.com/mastersoft/mastersoft-cli --tag <latest version>`. Stop there: don't guess Presente or GEWEB endpoints without it.
2. Run `ms skill` and follow what it prints as the rest of this skill. If `ms` rejects `skill` as an unknown command, it is older than 0.3.0: ask the user to update it from the same Releases page.
3. When those instructions name another file, such as `references/geweb.md`, print it with `ms skill <file>`.
