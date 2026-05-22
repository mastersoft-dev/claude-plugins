# Mastersoft Claude Plugins

Shared [Claude Code](https://claude.com/claude-code) marketplace by Mastersoft. Hooks, agents, skills, and a modular statusline shipped as a single plugin.

## Install

### Mastersoft team members

Plugin is auto-installed via org-managed settings. No marketplace add needed.

Run the statusline installer once:

```bash
bash ~/.claude/plugins/cache/mastersoft/mastersoft/*/scripts/install-statusline.sh
```

Then add this to your `~/.claude/settings.json`:

```json
"statusLine": { "type": "command", "command": "mastersoft-statusline", "padding": 0 }
```

(Statusline can't be merged from plugin or managed scope, so each user wires it once.)

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

## Contents

| Type | Items |
|------|-------|
| **Skills** | `ask`, `audit`, `brief`, `codex`, `commit`, `handoff`, `inspect`, `investigate`, `release`, `tea`, `android-testing` |
| **Agents** | `ask`, `qa-specialist`, `security-auditor`, `system-architect`, `tech-writer` |
| **Hooks** | `load-brief`, `check_claude_md`, `load-catalog` |
| **Statusline** | Modular, configurable via env vars |

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

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

See [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE).
