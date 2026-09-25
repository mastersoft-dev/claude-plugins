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
3. Start a session on your working copy with `scripts/dev.sh`. Arguments pass through to `claude`, for example `scripts/dev.sh -p "/mastersoft-dev:help"`. Restart it to pick up new edits.

### Why a renamed copy

Managed settings enable `mastersoft@mastersoft` for the organization, and Claude Code ignores a `--plugin-dir` plugin whose name is locked that way (`claude --debug` logs `--plugin-dir copy of "mastersoft" ignored: plugin is locked by managed settings`). A local directory marketplace doesn't help either: the managed marketplace entry named `mastersoft` replaces it. `scripts/dev.sh` syncs `plugins/mastersoft` into `$MASTERSOFT_DEV_DIR` (default `$TMPDIR/mastersoft-dev`), renames the manifest to `mastersoft-dev` and starts `claude --plugin-dir` on that copy. The sync skips `tests/`, `.DS_Store` and the Python caches (`__pycache__`, `.mypy_cache`), and deletes from the copy whatever no longer exists in the source. Symlinks can't replace the copy, because Claude Code rejects component paths that resolve outside the plugin directory.

The copy runs next to the installed plugin, so:

- skills show up as `/mastersoft-dev:<name>`;
- the hooks of both copies run, so injected context appears twice;
- a skill that delegates with `subagent_type: mastersoft:<agent>` still reaches the installed agent: invoke `mastersoft-dev:<agent>` directly to test an edited agent.

In a `-p --output-format stream-json --verbose` run, the `init` message lists the loaded plugins with their paths, which confirms the session is on the copy.

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
