---
name: doc
description: Author a project doc (ADR, PRD) under docs/<type>/ from a Mastersoft template. Use proactively when the user asks to "write an ADR", "create a PRD", "document this decision", "draft a requirements doc", or invokes /mastersoft:doc <type> "<title>". One skill, registry-driven, branches on the doc-type argument. For free-form prose docs (README, RFC, guides) use the tech-writer agent.
allowed-tools: Read, Write, Edit, Glob, Grep, AskUserQuestion, Bash(node:*), Bash(git:*), PowerShell
model: sonnet
argument-hint: "<type> \"<title>\" [--draft]"
---

# Doc

Author a structured project document from a Mastersoft template. One skill
for all doc types — the type is the first argument. The set of templates in
`references/*.md` IS the registry: this body has zero hardcoded type names,
so adding a type later means dropping a `references/<type>.md` file, nothing
here changes.

## Hard rule

Every doc this skill writes lands under `docs/<type>/`. The ONLY doc allowed
at repo root is `CLAUDE.md`. Never write a doc-type file anywhere else, and
refuse (don't relocate) if you find one misplaced.

## Procedure

1. **Resolve repo root** via `git rev-parse --show-toplevel`. Refuse with a
   one-line message if not inside a git work tree.

2. **Build the registry.** The templates live in this skill's own `references/`
   dir. The **Glob tool does not expand environment variables**, so globbing the
   raw `${CLAUDE_SKILL_DIR}/references/*.md` returns nothing → an empty registry →
   step 3 always prints "no enabled types" and stops. List them with the granted
   `node` instead (it resolves the var):
   ```bash
   node -e "const fs=require('fs'),d=process.env.CLAUDE_SKILL_DIR+'/references';console.log(fs.readdirSync(d).filter(f=>f.endsWith('.md')).join('\n'))"
   ```
   Each filename stem is a type (`adr`, `prd`, …). Read each template's YAML
   frontmatter — that's the per-type spec (`filename`, `dir`, `workflow`,
   `required-sections`, `short-fields`, `prose-fields`, `default-status`,
   `status-values`).

3. **Parse arguments.** `$1` = type, `$2` = title (quoted), optional `--draft`.
   - No `$1`, or `$1` not in the registry → print the enabled type list
     (`type — label` from each template's frontmatter) and stop. Do not guess.
   - No title → ask for one with a single `AskUserQuestion` (free text).

4. **Select the template** = `references/<type>.md`. Hold its frontmatter spec
   and skeleton body (everything after the closing `---`).

5. **Outside-docs/ guard** (type-derived, no hardcoded patterns). Glob for
   stray docs of THIS type outside `docs/`, deriving the search from the
   template's own `type` + `title-prefix` frontmatter:
   - filename-prefix glob: `**/{<type>,<TYPE>}-*.md` (e.g. `adr-*.md`, `ADR-*.md`)
   - if `filename: numbered`, also `**/[0-9][0-9][0-9][0-9]-*.md`
   - exclude anything under `docs/` and `.claude/`, and the names CLAUDE.md /
     AGENTS.md / README.md.
   For each candidate, confirm it's actually this doc type by header (e.g.
   `# <TITLE-PREFIX>` or a `**Status**:` line whose leading token is one of the
   template's `status-values` — so `Superseded by ADR-0003` matches `Superseded`)
   before treating it as a stray. If confirmed strays exist:
   - Print the offender path(s) + a suggested `git mv <path> docs/<type>/`.
   - **Refuse to proceed** via `AskUserQuestion`: "I found <path> outside docs/.
     Options: [I'll move it — abort so you can `git mv`] / [Not this doc type —
     proceed anyway]". Never move files yourself; that's the user's destructive op.

6. **Compute the filename** from the spec's `filename`:
   - `numbered` (ADR): Glob `docs/<type>/*.md`, extract leading `NNNN` from each.
     Next number = (max existing, or 0 if the dir is empty/absent) + 1,
     zero-padded to 4 digits — so the FIRST doc is `0001`. Slug = kebab-case of
     the title. Result: `docs/<type>/NNNN-slug.md`.
   - `slug` (PRD): kebab-case the title → `docs/<type>/<slug>.md`. If it already
     exists, `AskUserQuestion`: "append a section / pick a new slug / abort".

7. **Gather content** per the spec's `workflow`:
   - `template-fill` (current default for adr + prd):
     - **Short fields** (`short-fields`): one batched `AskUserQuestion` (≤4
       items per call). Defaults: Status → `default-status` (or `--draft` forces
       it), Date/Last-updated → today's date, Deciders/Owner → ask.
     - **Prose fields** (`prose-fields`): prompt the user in plain text, one
       field at a time or grouped, accepting shorthand. Keep each section tight;
       this is a first draft the user will refine, not a final artifact.
     - `--draft` → set Status to the draft-ish value and skip optional prompts
       (e.g. PRD Success metrics) — leave a `_(to be filled)_` placeholder instead
     (never a literal `TODO`, which the org's no-TODO-in-diffs rule flags).
   - `coauthor` (no type uses this yet): reserved for the heavier 3-stage
     context-gather → section-refine → reader-test flow. Not implemented here;
     if a future template sets it, fall back to `template-fill` and note it.

8. **Render + write.** Substitute the gathered values into the skeleton's
   `{{placeholders}}`. Write to the computed `docs/<type>/<filename>` with
   `Write`. Create the `docs/<type>/` path if absent (Write creates parents).

9. **Report**: created path, next steps (e.g. "fill the
    `_(to be filled)_` placeholders before marking Accepted/Approved").

## Refusal cases

- Not in a git repo → "Run inside a git repo."
- Unknown/missing type → list enabled types from the registry, stop.
- Doc-type file found outside `docs/` → refuse + suggest `git mv` (step 5).

## Notes

- **Registry-driven.** Never hardcode `adr`/`prd` in decisions — read it from
  the template frontmatter. Adding rfc/postmortem/runbook/onboarding later is
  purely: drop a `references/<type>.md` template. No edit here.
- **Batched questions.** Short fields go in ONE `AskUserQuestion` call (≤4
  items), never one-at-a-time. Same fatigue rule as `/mastersoft:promote-patterns`.
- **First draft, not final.** Don't over-polish. Leave a `_(to be filled)_`
  placeholder for anything the user didn't supply; they iterate after. ADRs are immutable once `Accepted`,
  so default new ones to `Proposed`.
- **Immutability.** Never edit an existing `Accepted` ADR's decision. To change
  a decision, create a new ADR and set the old one's Status to
  `Superseded by ADR-MMMM`.
