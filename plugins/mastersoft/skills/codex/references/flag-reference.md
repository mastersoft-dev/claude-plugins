# Flag Reference (codex-cli 0.132.x)

Scriptable surfaces: `codex exec`, `codex exec review`, `codex exec resume`, `codex cloud …`. Top-level `codex resume` and `codex fork` are interactive pickers. Top-level `codex review` runs non-interactively but lacks `--json`/`-o`/`-m` so the skill cannot monitor it (Hard Rule 1 — use `codex exec review`).

## `codex exec` flags

| Flag | Short | Purpose |
|------|-------|---------|
| `--config <key=value>` | `-c` | Repeatable. TOML-parsed override; falls back to string. |
| `--enable <FEATURE>` | | `-c features.<name>=true`. |
| `--disable <FEATURE>` | | `-c features.<name>=false`. |
| `--image <FILE>` | `-i` | Attach image(s). |
| `--model <MODEL>` | `-m` | Override model. |
| `--oss` / `--local-provider <id>` | | OSS provider or LM Studio / Ollama. |
| `--profile <ID>` | `-p` | Named config profile (v1). |
| `--profile-v2 <ID>` | | Named v2 config profile (added in 0.132). |
| `--strict-config` | | Error out on unknown config.toml fields (added in 0.132). |
| `--dangerously-bypass-hook-trust` | | Bypass hook-trust prompts (added in 0.132). |
| `--sandbox <policy>` | `-s` | `read-only` (default), `workspace-write`, `danger-full-access`. |
| `--dangerously-bypass-approvals-and-sandbox` | | CI-only. Implies `sandbox=danger-full-access` + `approval=never`. |
| `--cd <DIR>` | `-C` | Working directory. |
| `--add-dir <DIR>` | | Extra writable directory. |
| `--skip-git-repo-check` | | Allow running outside a git repo. |
| `--ephemeral` | | Don't persist session under `~/.codex/sessions` (disables resume). |
| `--ignore-user-config` | | Skip `~/.codex/config.toml`. Auth still read. |
| `--ignore-rules` | | Skip user/project `.rules`. |
| `--output-schema <FILE>` | | JSON Schema constraining final assistant text. |
| `--color <mode>` | | `always` / `never` / `auto`. |
| `--json` | | JSONL event stream on stdout. |
| `--output-last-message <FILE>` | `-o` | Write final assistant text at `turn.completed`. **Not incremental**; doesn't survive a mid-run kill. |

### Flags NOT on `codex exec`

`--full-auto` is a deprecated alias for `--sandbox workspace-write` — `codex exec` accepts it (0.132 still emits `warning: --full-auto is deprecated; use --sandbox workspace-write instead`). Skill never emits it. `--ask-for-approval` / `-a` is rejected outright by `codex exec` (`error: unexpected argument '--ask-for-approval' found`); use `-c approval_policy=<untrusted|on-request|never>` instead.

## `codex exec review` flags

| Flag | Purpose |
|------|---------|
| `--uncommitted` | Review staged + unstaged + untracked. |
| `--base <BRANCH>` | Review HEAD vs base. Accepts a branch, SHA, `HEAD~N`, or any rev-parseable ref. HEAD is the implicit second ref — not user-overridable. |
| `--commit <SHA>` | Review a specific commit. Accepts SHA, `HEAD`, `HEAD~N`, or branch name. |
| `--title <TITLE>` | Override review title. |
| `--model <MODEL>` / `-m` | Override model. |
| `--config <k=v>` / `-c` | Config override (model, effort, …). |
| `--enable <FEATURE>` | `-c features.<name>=true` (repeatable). |
| `--disable <FEATURE>` | `-c features.<name>=false` (repeatable). |
| `--strict-config` | Error on unknown config.toml fields (0.132). |
| `--json` | JSONL events. |
| `--output-last-message <FILE>` / `-o` | Final assistant text on `turn.completed`. |
| `--ephemeral`, `--skip-git-repo-check`, `--ignore-user-config`, `--ignore-rules`, `--dangerously-bypass-approvals-and-sandbox` | as in `exec`. |

Scope flags `--uncommitted`, `--base`, `--commit` are mutually exclusive — pass exactly one.

`--output-schema` is not supported on `codex exec review`.

## `codex exec resume` flags

Resume accepts a **subset** of `codex exec` flags (verified against codex-cli 0.132.0):

| Flag | Purpose |
|------|---------|
| `<UUID>` positional | Thread id (UUIDv7) from a prior `thread.started` event or `session_meta.payload.id`. |
| `--last` | Most recent persisted session. |
| `--all` | Disable cwd filtering. |
| `-c, --config <k=v>` | Config override. |
| `-i, --image <FILE>` | Attach image(s). |
| `-m, --model <MODEL>` | Override model. |
| `--enable <FEATURE>` / `--disable <FEATURE>` | Toggle features. |
| `--output-schema <FILE>` | JSON Schema constraining final text (added in 0.132). |
| `--strict-config` | Error on unknown config.toml fields (0.132). |
| `--dangerously-bypass-approvals-and-sandbox` | CI bypass. |
| `--dangerously-bypass-hook-trust` | Bypass hook-trust prompts (0.132). |
| `--skip-git-repo-check`, `--ephemeral`, `--ignore-user-config`, `--ignore-rules` | as in `exec`. |
| `--json` | JSONL events. |
| `-o, --output-last-message <FILE>` | Final assistant text. |

**NOT accepted by `resume`** (silently dropped or rejected): `--oss`, `--local-provider`, `-p`/`--profile`, `--profile-v2`, `-s`/`--sandbox`, `-C`/`--cd`, `--add-dir`, `--color`. These come from the persisted session's config; the resumed run cannot re-scope them.

Appends to `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<uuid>.jsonl`.

## `codex cloud …`

| Command | Required | Notes |
|---------|----------|-------|
| `cloud exec --env <ENV_ID> "<prompt>"` | `--env <id>` | Submit async task. |
| `cloud list [--json]` | | List tasks (only `list` supports `--json`). |
| `cloud status <task-id>` | | Poll status. |
| `cloud diff <task-id>` | | Show task diff. |
| `cloud apply <task-id>` | | Apply task locally. |

Server-side execution. No Bash-timeout concern.

## Sandbox / approval recipes

| Goal | Recipe |
|------|--------|
| Read-only (default) | `--sandbox read-only` |
| Unattended writes in cwd | `--sandbox workspace-write -c approval_policy=never` |
| Network in workspace-write | add `-c sandbox_workspace_write.network_access=true` |
| CI in external sandbox | `--dangerously-bypass-approvals-and-sandbox` |
| Outside a git repo | add `--skip-git-repo-check` |
| Reproducible (no user config / rules) | `--ignore-user-config --ignore-rules` |

Never combine `--dangerously-bypass-approvals-and-sandbox` with `--sandbox` — the former dominates.
