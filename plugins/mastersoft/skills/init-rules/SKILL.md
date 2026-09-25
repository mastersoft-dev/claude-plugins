---
name: init-rules
description: Scaffold Mastersoft project rule files (AGENTS.md, drafted by the native /init when the repo has no rules; .claude/rules/, docs/adr/, docs/prd/) following org conventions. Use proactively when the user asks to set up, scaffold, or initialize project rules, or starts a fresh repo, or acts on a no-rules-file signal — asks before creating each file, so it never scaffolds unprompted. Bootstrap only; to refresh existing rules use refresh-rules.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash(git:*), Bash(mv -n CLAUDE.md AGENTS.md), Bash(mv -n .claude/CLAUDE.md .claude/AGENTS.md), PowerShell, AskUserQuestion, Skill
---

# Init-Rules

Scaffolds Mastersoft project rule files in the current repo. Auto-detects tech stack; asks before creating each artifact.

## Inputs

Repo root resolved via `git rev-parse --show-toplevel`. Refuse if not inside a git work tree.

Templates live alongside this skill at `assets/`:

- `assets/AGENTS.md.tmpl` — the org sections of the project rules (shared across coding agents).
- `assets/CLAUDE.md.tmpl` — an optional `@AGENTS.md` compatibility pointer, written only on request.
- `assets/rules-README.md.tmpl`
- `assets/adr-README.md.tmpl`
- `assets/prd-README.md.tmpl`

## Procedure

1. **Resolve repo root.** Run `git rev-parse --show-toplevel`. Abort with a one-line error if it fails.

2. **Detect stack** by checking these files at repo root, in order. Record findings; you'll substitute them into templates:
   - `package.json` → JavaScript/TypeScript. Read `name`, `scripts`, `packageManager`. Detect lockfile: `pnpm-lock.yaml` (pnpm), `yarn.lock` (yarn), `bun.lockb` (bun), `package-lock.json` (npm).
   - `pyproject.toml` / `requirements*.txt` / `setup.py` → Python. Note tool (poetry / uv / pip).
   - `Cargo.toml` → Rust.
   - `go.mod` → Go.
   - `Gemfile` → Ruby.
   - `pubspec.yaml` → Dart/Flutter.
   - `composer.json` → PHP.
   - `.csproj` / `.sln` → .NET.

3. **Project rules file.** Rules live in `AGENTS.md`, which every coding agent reads; Claude Code 2.1.277+ loads it directly when the repo has no `CLAUDE.md`, `.claude/CLAUDE.md` or `CLAUDE.local.md`. Run every command in this step from the repo root. Check those five names at the root, then act on the first matching case. Never overwrite an existing file. `CLAUDE.local.md` is personal and gitignored: never move it or copy it into `AGENTS.md`.
   - **No `AGENTS.md` and no team `CLAUDE.md`** (`CLAUDE.md`, `.claude/CLAUDE.md`) → ask once whether to create `AGENTS.md`. On yes:
     1. Invoke the native `init` skill with the Skill tool. It analyses the codebase and writes a rules file.
     2. Check the five names again. If `/init` wrote `CLAUDE.md`, run `mv -n CLAUDE.md AGENTS.md`; if it wrote `AGENTS.md`, keep it. If the move is denied, stop and tell the user to rename or delete `CLAUDE.md` themselves, because it would keep `AGENTS.md` from loading.
     3. Replace the opening line ("This file provides guidance to Claude Code …") with one that addresses every coding agent, then append the sections of `assets/AGENTS.md.tmpl` that `/init` didn't cover (Conventions, Workflow, and any Build & test line it left out). Keep what `/init` wrote.
     Only when `/init` is unavailable and no rules file exists afterwards, create `AGENTS.md` from the template alone.
   - **Only `AGENTS.md`** (root or `.claude/`) → create nothing. Offer to append the template sections it lacks.
   - **Only a team `CLAUDE.md`** → offer to rename it, keeping its directory so relative `@` imports still resolve: `git mv CLAUDE.md AGENTS.md` or `git mv .claude/CLAUDE.md .claude/AGENTS.md`; for an untracked file use `mv -n` with the same paths. On no, leave it and suggest `/mastersoft:refresh-rules` for later.
   - **Team `CLAUDE.md` and `AGENTS.md`** → create nothing. If `CLAUDE.md` doesn't import the `AGENTS.md` (`@AGENTS.md`, or `@../AGENTS.md` from `.claude/CLAUDE.md`), say that Claude Code isn't loading it and offer to add the import. If `CLAUDE.md` holds only the import, say it matters only for Claude Code older than 2.1.277 or with the built-in `agents-md` plugin disabled.
   - **After any case**, if `CLAUDE.local.md` exists and the rules live in `AGENTS.md` with no team `CLAUDE.md` importing it, warn that Claude Code then stops reading `AGENTS.md`. The fix is `"pluginConfigs": {"agents-md@builtin": {"options": {"instructionFiles": "claude-md-and-agents-md"}}}` in `~/.claude/settings.json`, or `@AGENTS.md` inside `CLAUDE.local.md`.
   - Write the `assets/CLAUDE.md.tmpl` pointer only when the user asks for it.

4. **Other artifacts.** For each, ask whether to scaffold it (one `AskUserQuestion` per artifact unless absent files are unambiguous). If it exists, skip and report "exists, skipped".

   | Artifact | Path | Template |
   |---|---|---|
   | rules dir | `<root>/.claude/rules/README.md` | `assets/rules-README.md.tmpl` |
   | ADR dir | `<root>/docs/adr/README.md` | `assets/adr-README.md.tmpl` |
   | PRD dir | `<root>/docs/prd/README.md` | `assets/prd-README.md.tmpl` |

   Substitute placeholders in each template using detected values:
   - `{{STACK}}` — short description (e.g. "TypeScript / Next.js").
   - `{{PKG_MANAGER}}` — pnpm | yarn | bun | npm | pip | poetry | uv | cargo | go | bundler | dart | …
   - `{{TEST_CMD}}` — best guess based on `package.json` scripts / Makefile / `pyproject.toml` (e.g. `pnpm test`, `pytest`, `cargo test`).
   - `{{REPO_NAME}}` — basename of repo root.
   - `{{DATE}}` — today, YYYY-MM-DD.

5. **Final output block** (always print, regardless of choices):

   ```
   ## Scaffolded

   <list each artifact: "✓ created <path>" or "= existed, skipped <path>">

   ## Recommended periodic check

   Run a semantic verify from time to time, in a local session:

       /mastersoft:verify --report-only

   Cloud routines created with /schedule don't load plugins, so they can't run it.

   ## Writing docs

   This scaffolds the docs/ directories + READMEs. To author an actual
   ADR or PRD (auto-numbered, template-filled), use:

       /mastersoft:doc adr "Short decision title"
       /mastersoft:doc prd "feature-slug"

   All design docs live under docs/<type>/; only CLAUDE.md and AGENTS.md
   belong at repo root. Available types come from the `/mastersoft:doc` template registry.

   ## Native commands you may not be using (availability varies by Claude Code version — run /help to confirm)

   - /insights      — analyse your sessions, surface friction points and patterns
   - /context [all] — current context-window breakdown + optimization suggestions
   - /team-onboarding — generate a teammate setup guide from your 30-day usage
   - /usage         — per-skill / subagent / plugin / MCP cost breakdown
   ```

## Refusal cases

- Not in a git work tree → "Run `git init` first, then re-invoke /mastersoft:init-rules."
- All artifacts already exist → print summary, recommend `/mastersoft:refresh-rules` instead.

## Notes

- Never overwrite an existing file. If user wants to redo, they delete it first.
- Templates are intentionally short. Customisation happens in `/mastersoft:refresh-rules`.
- Rules live in `AGENTS.md` (tool-neutral). Claude Code 2.1.277+ reads it on its own; a `CLAUDE.md` with `@AGENTS.md` is only a compatibility pointer for older versions or when the `agents-md` plugin is disabled.
