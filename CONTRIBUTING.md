# Contributing

Thanks for considering a contribution. The repo follows a small set of conventions; please read this once before opening a PR.

## Layout

All shipped content lives under `plugins/mastersoft/`:

- `hooks/` — JS hooks loaded by Claude Code (`hooks.json` declares wiring)
- `agents/` — Markdown agent definitions
- `skills/<name>/SKILL.md` — skill entry points, with optional `references/` and `assets/` siblings
- `scripts/` — installers and helper scripts

The top-level `.claude-plugin/marketplace.json` is the marketplace manifest; it points at `plugins/mastersoft`. The plugin version lives only in `plugins/mastersoft/.claude-plugin/plugin.json`.

## Local development

1. Fork and clone the repo.
2. Edit content under `plugins/mastersoft/`.
3. Start a session on your working copy with `scripts/dev.sh`. Arguments pass through to `claude`, for example `scripts/dev.sh -p "/mastersoft-dev:help"`. Restart it to pick up new edits.

### Why a renamed copy

Managed settings enable `mastersoft@mastersoft` for the organization, and Claude Code ignores a `--plugin-dir` plugin whose name is locked that way (`claude --debug` logs `--plugin-dir copy of "mastersoft" ignored: plugin is locked by managed settings`). A local directory marketplace doesn't help either: the managed marketplace entry named `mastersoft` replaces it. `scripts/dev.sh` syncs `plugins/mastersoft` into `$MASTERSOFT_DEV_DIR` (default `$TMPDIR/mastersoft-dev`), renames the manifest to `mastersoft-dev`, rewrites the copy's Markdown references from `mastersoft:<name>` to `mastersoft-dev:<name>` so its skills delegate to its own agents, and starts `claude --plugin-dir` on that copy. The sync skips `tests/`, `.DS_Store` and the Python caches (`__pycache__`, `.mypy_cache`), and deletes from the copy whatever no longer exists in the source. Symlinks can't replace the copy, because Claude Code rejects component paths that resolve outside the plugin directory.

The copy runs next to the installed plugin, so:

- skills show up as `/mastersoft-dev:<name>`;
- the hooks of both copies run, so injected context appears twice.

In a `-p --output-format stream-json --verbose` run, the `init` message lists the loaded plugins with their paths, which confirms the session is on the copy.

### Test and debug

- Run the suites: `for t in plugins/mastersoft/tests/*.e2e.js plugins/mastersoft/tests/*.test.js; do node "$t"; done`. The GitLab pipeline (`.gitlab-ci.yml`) runs them, the Android daemon tests and both `claude plugin validate --strict` checks on every merge request, without credentials.
- `claude plugin validate --strict plugins/mastersoft` and `claude plugin validate --strict .` check the plugin and marketplace manifests and the frontmatter of every skill, agent and command.
- In a `scripts/dev.sh` session, the **Errors** tab of `/plugin` lists what failed to load and why.
- The hooks fail quietly on purpose: `lint-engine` writes `[mastersoft] lint-engine skipped: …` to stderr and exits 0, so the prompt goes on. Start the session with `scripts/dev.sh --debug-file /tmp/ms-debug.log`, or run `/debug` in a running one, trigger the event, and search the log for `[mastersoft]` and the hook's event: it shows which hooks matched, their exit codes and their output.
- Before cutting or merging skills, `claude --plugin-dir "$MASTERSOFT_DEV_DIR" plugin details mastersoft-dev` shows the always-on tokens each skill and agent adds to every session, and `/skill-doctor` (Claude Code 2.1.252+) shows how often each skill is used. Neither counts the context the hooks inject: `/context` in a session does.

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

Any change inside `plugins/mastersoft/` requires bumping `version` in `plugins/mastersoft/.claude-plugin/plugin.json`. The marketplace entry carries no version: Claude Code reads `plugin.json` first, and `claude plugin validate` reports a mismatch when both set one. Use semver: bug fix = patch, additive change = minor, breaking change = major.

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
