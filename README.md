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

In a Claude Code session (v2.1.275 or later), add the marketplace and install in one command:

```text
/plugin install mastersoft --marketplace mastersoft-dev/claude-plugins
```

Or from your shell:

```bash
claude plugin marketplace add mastersoft-dev/claude-plugins
claude plugin install mastersoft@mastersoft
```

The in-session install activates the plugin when it finishes (before Claude Code v2.1.268, run `/reload-plugins` as well). A shell install takes effect in the next session, or after `/reload-plugins` in one that is already running.

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
once. `--apply` patches the `settings.json` in `$CLAUDE_CONFIG_DIR` (default
`~/.claude`; requires `jq`); without the flag the wrapper is copied and the JSON
block is printed to paste manually:

```bash
bash "$(jq -r '.plugins["mastersoft@mastersoft"][0].installPath' ~/.claude/plugins/installed_plugins.json)/scripts/install-statusline.sh" --apply
```

Idempotent: re-running with `--apply` is a no-op once wired. If a different
`statusLine` is already set, it refuses to overwrite — use
`~/.claude/statusline.local.json` with `{"command":"..."}` to override at runtime
via the wrapper instead.

## Contents

| Type | Items |
|------|-------|
| **Skills** | `ack-lints`, `adversary`, `android-testing`, `ask`, `audit`, `audit-deps`, `babysit`, `codex`, `commit`, `doc`, `glab`, `handoff`, `help`, `init-rules`, `investigate`, `promote-patterns`, `recall`, `refresh-rules`, `release`, `sentry`, `verify`, `vet` |
| **Agents** | `ask-explore`, `code-reviewer`, `devils-advocate`, `hindsight`, `qa-specialist`, `rule-auditor`, `security-auditor`, `system-architect`, `tech-writer` |
| **Hooks** | `install-statusline-wrapper` (SessionStart), `inject-session` (SessionStart), `reset-session-state` (SessionStart clear + PostCompact), `lint-engine` + `inject-turn` (UserPromptSubmit), `suggest-push` (PreToolUse:Bash\|PowerShell), `inject-org-rules` (SubagentStart) |
| **Output styles** | `Brief`: the shortest correct answer, stricter than the built-in Concise style. Pick it with `/output-style` or `/config` |
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
| `rate_limit` | Claude.ai rate limit usage: 5h window (with reset countdown), plus 7d and spend-limit windows when present | no |
| `tokens_in` | Total input tokens | no |
| `tokens_out` | Total output tokens | no |
| `lines` | `+added -removed` lines | no |
| `cache` | Prompt cache hit ratio and warm/cold state, plus the last miss's cause when known | no |

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

`quiet`, `org_rules` and `push_protected_branches` are also plugin options, set with `/plugin configure mastersoft@mastersoft` or `/config`. An env var wins over the option.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

See [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE).
