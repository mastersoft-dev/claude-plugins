---
name: init-rules
description: Scaffold Mastersoft project rule files (AGENTS.md + a CLAUDE.md that imports it, .claude/rules/, docs/adr/, docs/prd/) following org conventions. Use proactively when the user asks to set up, scaffold, or initialize project rules, or starts a fresh repo, or acts on a no-rules-file signal — asks before creating each file, so it never scaffolds unprompted. Bootstrap only; to refresh existing rules use refresh-rules.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash(git:*), PowerShell, AskUserQuestion
---

# Init-Rules

Scaffolds Mastersoft project rule files in the current repo. Auto-detects tech stack; asks before creating each artifact.

## Inputs

Repo root resolved via `git rev-parse --show-toplevel`. Refuse if not inside a git work tree.

Templates live alongside this skill at `assets/`:

- `assets/AGENTS.md.tmpl` — the actual project rules (shared across coding agents).
- `assets/CLAUDE.md.tmpl` — a one-line `@AGENTS.md` import so Claude Code (which reads only `CLAUDE.md`) loads them.
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

3. **For each artifact below**, ask the user whether to scaffold it (use `AskUserQuestion` with a single question per artifact unless absent files are unambiguous). If the file/dir already exists, skip and report "exists, skipped" — never overwrite. Auto-act on the answer:

   | Artifact | Path | Template |
   |---|---|---|
   | project rules | `<root>/AGENTS.md` | `assets/AGENTS.md.tmpl` |
   | CLAUDE.md pointer | `<root>/CLAUDE.md` | `assets/CLAUDE.md.tmpl` |
   | rules dir | `<root>/.claude/rules/README.md` | `assets/rules-README.md.tmpl` |
   | ADR dir | `<root>/docs/adr/README.md` | `assets/adr-README.md.tmpl` |
   | PRD dir | `<root>/docs/prd/README.md` | `assets/prd-README.md.tmpl` |

   **Rules-file pairing** (`AGENTS.md` + `CLAUDE.md`) — treat as one decision, since Claude Code reads only `CLAUDE.md` and loads `AGENTS.md` solely via its `@AGENTS.md` import:
   - Neither exists → create both (rules in `AGENTS.md`, pointer in `CLAUDE.md`).
   - `AGENTS.md` exists (another tool already uses it), `CLAUDE.md` missing → create only the `CLAUDE.md` pointer; leave `AGENTS.md` untouched.
   - `CLAUDE.md` already exists (any content) → skip both; never overwrite. If it holds inline rules rather than an import, suggest `/mastersoft:refresh-rules` to migrate them into `AGENTS.md`.

   Substitute placeholders in each template using detected values:
   - `{{STACK}}` — short description (e.g. "TypeScript / Next.js").
   - `{{PKG_MANAGER}}` — pnpm | yarn | bun | npm | pip | poetry | uv | cargo | go | bundler | dart | …
   - `{{TEST_CMD}}` — best guess based on `package.json` scripts / Makefile / `pyproject.toml` (e.g. `pnpm test`, `pytest`, `cargo test`).
   - `{{REPO_NAME}}` — basename of repo root.
   - `{{DATE}}` — today, YYYY-MM-DD.

4. **Final output block** (always print, regardless of choices):

   ```
   ## Scaffolded

   <list each artifact: "✓ created <path>" or "= existed, skipped <path>">

   ## Recommended periodic check

   Run this once to set up a weekly semantic-verify routine that opens a report:

       /schedule weekly run /mastersoft:verify --report-only

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
- Rules live in `AGENTS.md` (tool-neutral); `CLAUDE.md` is just `@AGENTS.md` so Claude Code loads them. A bare `AGENTS.md` with no `CLAUDE.md` is **not** read by Claude Code — the `CLAUDE.md` pointer is what makes it load.
