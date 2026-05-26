# Contributing

Thanks for considering a contribution. The repo follows a small set of conventions; please read this once before opening a PR.

## Layout

All shipped content lives under `plugins/mastersoft/`:

- `hooks/` — JS hooks loaded by Claude Code (`hooks.json` declares wiring)
- `agents/` — Markdown agent definitions
- `agent-refs/<agent>/<topic>.md` — progressive-disclosure reference files the agents load on demand via their "Required Reading" tables (the agent equivalent of a skill's `references/`)
- `skills/<name>/SKILL.md` — skill entry points, with optional `references/` and `assets/` siblings
- `scripts/` — installers and helper scripts

The top-level `.claude-plugin/marketplace.json` is the marketplace manifest; it points at `plugins/mastersoft` and pins the version.

## Local development

1. Fork and clone the repo.
2. Edit content under `plugins/mastersoft/`.
3. Reload inside a Claude session with `/reload-plugins` (the marketplace install pulls from your fork once you point it at the local clone, or you can edit the cached copy under `~/.claude/plugins/cache/mastersoft/mastersoft/<version>/` for quick iteration).

### Statusline development

To iterate on the statusline without reinstalling the plugin every time, point `statusLine.command` directly at your clone:

```json
"statusLine": {
  "type": "command",
  "command": "node /path/to/claude-plugins/plugins/mastersoft/hooks/statusline.js",
  "padding": 0
}
```

A `git pull` in that directory picks up changes instantly.

## Commit style

This repo uses [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` user-visible additions
- `fix:` bug fixes
- `docs:` documentation only
- `chore:` repo plumbing (version bumps, ignore lists)
- `refactor:` no behavior change
- `test:` test-only changes
- `perf:` performance work

Atomic commits — one concern per commit. Do not mix a refactor with a feature.

## Versioning

Any change inside `plugins/mastersoft/` requires bumping the version in:

- `plugins/mastersoft/.claude-plugin/plugin.json`
- `.claude-plugin/marketplace.json`

Both must match. Use semver: bug fix = patch, additive change = minor, breaking change = major.

## Pull request checklist

- [ ] Conventional Commits subject
- [ ] Plugin version bumped (if anything under `plugins/mastersoft/` changed)
- [ ] README / skill docs updated when behavior changes
- [ ] No secrets, tokens, or internal hostnames in the diff
- [ ] Manually verified the change in a real Claude Code session

## Reporting bugs and requesting features

Use the issue templates in `.github/ISSUE_TEMPLATE/`. For security issues, see [SECURITY.md](SECURITY.md) instead.

## Code of conduct

Be respectful. Bad behavior gets the offender removed from the project; no warnings.
