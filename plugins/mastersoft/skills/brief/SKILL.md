---
name: brief
description: Create or update BRIEF.md providing project context for Claude Code sessions. Includes tech stack, conventions, known issues, dependency sync.
allowed-tools: Read, Write, Edit, Glob, Grep
---

# Project Brief Management

Create and maintain `BRIEF.md` files that provide project context to Claude Code sessions.

## Context

- Existing brief: !`test -f BRIEF.md && echo "EXISTS" || echo "MISSING"`
- Package files: !`ls -1 package.json pyproject.toml Cargo.toml go.mod Gemfile pom.xml requirements.txt 2>/dev/null || echo "none"`
- Top-level dirs: !`ls -1 -d */ 2>/dev/null | head -20`
- README present: !`test -f README.md && echo "yes" || echo "no"`

## BRIEF.md Location

Always create/update `BRIEF.md` in the **current working directory** (project root).

## Template Structure

When creating a new BRIEF.md, copy the template from `assets/brief-template.md`.

Key sections: Overview, Tech Stack, Architecture, Conventions, Key Files, Current Focus, Known Issues, Tech Debt, Commands.

## Operations

Four operations: **Create**, **Update**, **Review**, **Sync Dependencies**.

For detailed steps and the dependency file watch table, consult `references/operations.md`.

## Guidelines

- Keep briefs concise - they're loaded on every prompt
- Focus on information that helps Claude understand context
- Update "Current Focus" section frequently
- Don't duplicate info that's in README.md
- Use bullet points over prose for scannability
- **Proactively sync** when you notice dependency changes during work

## Integration with Error-Recovery

Record solved project-specific errors in the "Known Issues" section. Flow:

1. Error occurs -> check BRIEF.md "Known Issues" first
2. If not found -> check auto-memory (`~/.claude/projects/*/memory/`)
3. If solved -> persist to BRIEF.md "Known Issues" (if project-specific)

Keep "Known Issues" entries actionable:

```markdown
- **Error**: `Cannot find module '@/utils'` -> **Fix**: Add paths to tsconfig.json
```

## Worked Example

User says: "Create a brief for this project"

1. **Check** — Verify no existing BRIEF.md in project root
2. **Scan** — Read `package.json`, `tsconfig.json`, project structure
3. **Infer** — Detect: TypeScript + Next.js + PostgreSQL + Prisma
4. **Generate** — Write BRIEF.md from template with discovered tech stack, directory layout, and available scripts
5. **Prompt** — Ask user to fill gaps: "What's the current focus area?"

Result: BRIEF.md created with auto-detected context; user fills in 2 fields.

## Common Issues

### Brief becomes stale
**Cause:** Tech stack or focus area changed but BRIEF.md not updated.
**Fix:** Run `brief --sync` after dependency changes; update "Current Focus" when switching work areas.

### Brief duplicates README
**Cause:** Copying README content instead of complementing it.
**Fix:** BRIEF.md is for Claude context (conventions, known issues, commands); README is for humans. Don't duplicate.

## Additional Resources

- **`references/template.md`** — Full BRIEF.md template with all sections
- **`references/operations.md`** — Detailed create/update/review/sync workflows and dependency watch table
- **`references/testing.md`** — Troubleshooting, test protocols, and success criteria

## Help

### Synopsis
Create, update, or review project BRIEF.md files for Claude Code context.

### Examples
- `brief` - Create or review project brief
- `brief --update` - Update existing brief with current project state
- `brief --sync` - Sync dependencies to tech stack section

### Checklist
- Analyze project structure and dependency files.
- Generate concise, scannable BRIEF.md.
- Preserve existing sections when updating.
- Keep entries actionable and up-to-date.
