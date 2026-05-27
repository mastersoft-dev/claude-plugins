# Mastersoft Claude Plugins

Shared [Claude Code](https://claude.com/claude-code) marketplace by Mastersoft. Hooks, agents, skills, and a modular statusline shipped as a single plugin.

## Install

### Mastersoft team members

Everything is automatic via org-managed settings — no marketplace add, no manual
steps. The org distributes `statusLine.command` (it points at the wrapper), and the
plugin's SessionStart hook keeps `~/.claude/mastersoft-statusline-wrapper.js`
refreshed on every launch. The status line appears on its own.

Want your own status line instead of the mastersoft default? Drop
`~/.claude/statusline.local.json` with `{"command":"..."}` — the wrapper honors it
over the default. Delete the file to revert.

### External users

```bash
/plugin marketplace add https://github.com/mastersoft-dev/claude-plugins.git
/plugin install mastersoft@mastersoft
/reload-plugins
```

Or declarative, in `~/.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "mastersoft": {
      "source": { "source": "github", "repo": "mastersoft-dev/claude-plugins" }
    }
  },
  "enabledPlugins": { "mastersoft@mastersoft": true }
}
```

Without org-managed settings the status line isn't wired automatically — wire it
once. `--apply` patches `~/.claude/settings.json` (requires `jq`); without the flag
the wrapper is copied and the JSON block is printed to paste manually:

```bash
bash ~/.claude/plugins/cache/mastersoft/mastersoft/*/scripts/install-statusline.sh --apply
```

Idempotent: re-running with `--apply` is a no-op once wired. If a different
`statusLine` is already set, it refuses to overwrite — use
`~/.claude/statusline.local.json` with `{"command":"..."}` to override at runtime
via the wrapper instead.

## Contents

| Type | Items |
|------|-------|
| **Skills** | `ack-lints`, `adversary`, `android-testing`, `ask`, `audit`, `audit-deps`, `codex`, `commit`, `handoff`, `help`, `init-rules`, `investigate`, `refresh-rules`, `release`, `tea`, `verify`, `vet` |
| **Agents** | `ask`, `code-reviewer`, `devils-advocate`, `qa-specialist`, `rule-auditor`, `security-auditor`, `system-architect`, `tech-writer` |
| **Hooks** | `install-statusline-wrapper` (SessionStart), `reset-session-state` (SessionStart clear + PostCompact), `lint-engine` + `inject-turn` (UserPromptSubmit), `suggest-push` (PreToolUse:Bash), `inject-org-rules` (SubagentStart) |
| **Statusline** | Modular, configurable via env vars |

> Run `/mastersoft:help` from inside a Claude session for the live signal catalog, env-var reference, and suppression mechanisms.

## Statusline

### Segments

Configured via `CLAUDE_STATUSLINE_SEGMENTS` env var (comma-separated). Default: `model,folder,branch,context,cost`.

| Name | Shows | Default |
|------|-------|---------|
| `model` | Current Claude model | yes |
| `folder` | Current directory basename | yes |
| `branch` | Git branch + state symbols (`*` modified, `+` staged, `?` untracked, `!` conflicts, `↑n` ahead, `↓n` behind, `≡n` stash) | yes |
| `context` | Context used: `<tokens> (<percent>%)` | yes |
| `cost` | Chat cost `$X.XX chat` | yes |
| `user` | `$USER` | no |
| `host` | short hostname | no |
| `repo` | Repo name from `origin` | no |
| `context_remaining` | Context remaining | no |
| `rate_limit` | Claude.ai 5h block countdown | no |
| `tokens_in` | Total input tokens | no |
| `tokens_out` | Total output tokens | no |
| `lines` | `+added -removed` lines | no |

Personal override:

```json
{
  "env": {
    "CLAUDE_STATUSLINE_SEGMENTS": "user,host,model,folder,branch,context,cost,tokens_in,tokens_out"
  }
}
```

### Icon sets

Env var `CLAUDE_STATUSLINE_ICONS` (default `emoji`):

| Value | Requirements |
|-------|--------------|
| `emoji` | UTF-8 terminal |
| `nerd` | Patched Nerd Font |
| `ascii` | Basic Unicode |
| `none` | text-only |

## Updating

```bash
/plugin marketplace update mastersoft
/reload-plugins
```

## Suppression

| Mechanism | Scope | How |
|---|---|---|
| `MASTERSOFT_QUIET=1` (or `=all`, `=true`) | Shell process | Suppress preamble + signals entirely. CI-friendly. |
| `MASTERSOFT_QUIET=lints` | Shell process | Keep ORG preamble; suppress lint signals only. |
| `.claude/.mastersoft-lints-ack` | Per repo, ~4h TTL | Defer lint signals for the session window. Touched by `/mastersoft:ack-lints defer`. |
| `.claude/.mastersoft-lints-suppress` | Per repo, indefinite | Disable lint signals in this repo until the file is deleted. |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

See [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE).
