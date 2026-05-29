# glab Skill — Testing & Troubleshooting

## Prerequisites

- `glab` CLI installed and in PATH (`brew install glab` on macOS)
- Authenticated to at least one host (`glab auth status` shows a green check)
- Current directory is a git repo with a GitLab remote (for context-aware commands)

## Test Protocol

### 1. Installation check

```bash
command -v glab >/dev/null 2>&1 && echo "OK" || echo "MISSING"
glab --version
```

**Pass:** Version string printed (e.g. `glab 1.100.0`).
**Fail:** "MISSING" or command not found.

### 2. Authentication check

```bash
glab auth status
glab auth status --all
```

**Pass:** Username + host displayed; token scope ≥ `api`.
**Fail:** "not authenticated" or 401 — re-run `glab auth login --hostname <host> --token <new>`.

### 3. Context detection

```bash
# Inside a git repo cloned from GitLab
glab repo view
```

**Pass:** Project details displayed (path, default branch, URL).
**Fail:** "could not determine project" → check `git remote -v` resolves to a known GitLab host.

### 4. MR operations

```bash
glab mr list --per-page 5
glab mr view 1   # or any known MR IID
```

**Pass:** List or details displayed.
**Fail:** 401/403 (auth) or 404 (wrong project / IID doesn't exist).

### 5. Issue operations

```bash
glab issue list --per-page 5
```

**Pass:** Issue list displayed.

### 6. CI surface (read-only, safe)

```bash
glab ci status --compact
glab ci list --per-page 3
glab ci lint   # validates .gitlab-ci.yml if present
```

### 7. API passthrough

```bash
glab api projects/:fullpath
glab api projects/:fullpath/members
```

**Pass:** JSON response with project metadata.
**Fail:** `:fullpath` placeholder didn't resolve → not in a recognized GitLab repo.

## Common failure patterns

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `401 Unauthorized` | Token expired, revoked, or missing `api` scope | Re-run `glab auth login --hostname <host> --token <new>` |
| `404 Not Found` | Wrong project, MR/issue IID doesn't exist, or `:fullpath` not resolved | Pass `-R <group/project>` explicitly |
| `not authenticated` | No login configured for the active host | `glab auth status --all` then `glab auth login` for the host |
| Command hangs | Required text input missing → editor / prompt opened | Always pass `--title`, `--description "<text>"`, and `--yes` |
| `glab mr merge` does nothing visible | `--auto-merge=true` (default) waits for pipeline + approvals | Pass `--auto-merge=false` to merge immediately (rare) |
| `glab ci view` looks frozen | TUI — incompatible with the harness | Use `ci status`, `ci trace`, `ci list` instead |
| `description=-` opens editor | Editor sentinel reached Claude Code | Replace `-` with the literal text |
| TLS handshake / cert error | Self-signed or untrusted CA | Configure system trust store; glab does not expose `--insecure` for `api` calls |

## Success criteria

- [x] `glab -h` returns help text
- [x] `glab auth status` shows authenticated user + host
- [x] `glab mr list` returns results for the current repo
- [x] `glab issue list` returns results for the current repo
- [x] `glab mr create … --yes` successfully creates an MR (manual test)
- [x] `glab mr checkout <iid>` checks out the MR's source branch locally
- [x] `glab ci status` reports the pipeline state for the current branch
- [x] `glab api projects/:fullpath` returns project metadata as JSON
