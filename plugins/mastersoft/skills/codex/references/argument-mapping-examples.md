# Argument Mapping Examples

All routes target `codex exec …` (Rule 1) with the canonical suffix (see SKILL.md). Abbreviation `<S>` = `--json -c model_reasoning_effort="<level>" -o "$final" < /dev/null > "$log" 2>&1`.

## Exec

- `/codex refactor the auth module` → `codex exec "refactor the auth module" <S>`
- `/codex --model gpt-5.5 explain this codebase` → `codex exec -m gpt-5.5 "explain this codebase" <S>`
- `/codex --sandbox workspace-write fix all lint errors` → `codex exec --sandbox workspace-write -c approval_policy=never "fix all lint errors" <S>`

## Review (Rule 4)

- `/codex review --base main` → `codex exec review --base main <S>`
- `/codex review --uncommitted` → `codex exec review --uncommitted <S>`
- `/codex review latest changes` clean tree → `codex exec review --commit HEAD <S>`
- `/codex review latest changes` dirty tree → `codex exec review --uncommitted <S>`
- `/codex review changes between 82275dd and HEAD` → `codex exec review --base 82275dd <S>` (HEAD implicit; review takes one ref)
- `/codex review this plan for gaps` (colloquial, no git scope) → `codex exec "review this plan for gaps" <S>`
- `/codex --xhigh review --base main` → effort=`xhigh`, route=`codex exec review --base main`. Rule 2 → background/cloud.

## Effort (Rule 3)

Whitelist: `--minimal`, `--low`, `--high`, `--xhigh`, `--ultrathink`, `"ultrathink"`. Else `medium`. Adjectives, bare `xhigh`, "fast", "deep think" do NOT promote.

- `/codex --low explain this fast` → effort=`low` (from flag; "fast" alone wouldn't promote)
- `/codex --high design the schema` → effort=`high` (Bash timeout 600000)
- `/codex --ultrathink design …` → effort=`xhigh` (background)
- `/codex ultrathink the schema design` → effort=`xhigh` (bare keyword)

## Resume

- `/codex resume` → `codex exec resume --last "continue" <S>`
- `/codex resume <UUID>` → `codex exec resume <UUID> "continue" <S>`

## Cloud

- `/codex cloud exec --env my-env "fix the bug"` → passthrough
- `/codex cloud review …` (async PR review) → `codex cloud exec --env <ID> "<review prompt>"`, then `codex cloud status <task-id>`
