# Tea Skill — Testing & Troubleshooting

## Prerequisites

- `tea` CLI installed and in PATH
- At least one login configured (`tea login list` shows entries)
- Current directory is a git repo with a Gitea remote (for context-aware commands)

## Test Protocol

### 1. Installation Check

```bash
command -v tea >/dev/null 2>&1 && echo "OK" || echo "MISSING"
tea --version
```

**Pass:** Version string printed.
**Fail:** "MISSING" or command not found.

### 2. Authentication Check

```bash
tea whoami
tea login list
```

**Pass:** Username and at least one login displayed.
**Fail:** Error or empty list.

### 3. Context Detection

```bash
# Inside a git repo cloned from Gitea
tea repo
```

**Pass:** Repository details displayed (owner, name, URL).
**Fail:** "repository not found" or wrong repo detected.

### 4. PR Operations

```bash
# List PRs
tea pr list --state open --limit 5

# Show a specific PR
tea pr 1
```

**Pass:** PR list or details displayed.
**Fail:** 401/403 (auth issue) or 404 (wrong repo/login).

### 5. Issue Operations

```bash
tea issue list --state open --limit 5
```

**Pass:** Issue list displayed.
**Fail:** Same error patterns as PR operations.

## Common Failure Patterns

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| `401 Unauthorized` | Token expired or revoked | Regenerate at `<instance>/user/settings/applications` |
| `404 Not Found` | Wrong repo or login context | Use `--login` and `--repo` flags |
| `no default login` | No login configured | Run `tea login add` |
| `remote not found` | Git remote doesn't match any login | Check `git remote -v` vs `tea login list` URLs |
| `branch already exists` | PR checkout conflicts | Delete local branch first |
| `TLS handshake error` | Self-signed cert or network issue | Check URL and network; use `--insecure` if allowed |

## Success Criteria

- [x] `tea -h` returns help text
- [x] `tea whoami` shows authenticated user
- [x] `tea pr list` returns results for the current repo
- [x] `tea issue list` returns results for the current repo
- [x] `tea pr create` successfully creates a PR (manual test)
- [x] `tea pr checkout <id>` creates a local branch tracking the PR
