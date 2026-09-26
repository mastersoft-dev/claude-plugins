# claude-plugins — project rules

Rules for working on the Mastersoft Claude Code plugin, shared across coding
agents. Layout, local development, tests and commit types are in
[CONTRIBUTING.md](CONTRIBUTING.md); this file holds what it doesn't say.

## Stack

Claude Code plugin: Markdown skills and agents, Node.js hooks and scripts with no
dependencies, Python helpers for the Android skill. No package manager.

## Build & test

- Suites: `for t in plugins/mastersoft/tests/*.e2e.js plugins/mastersoft/tests/*.test.js; do node "$t"; done`
- Android: `cd plugins/mastersoft/skills/android-testing/scripts && python3 test-daemon.py && python3 test-wedge.py`
- Manifests: `claude plugin validate --strict .` and `claude plugin validate --strict plugins/mastersoft`
- Shell: `shellcheck` on every `.sh` you touch. CI config: `glab ci lint`. Both are local only.
- The GitLab pipeline runs the suites, the Android tests and both validates on every MR; push only with everything above green locally.

## Conventions

- Repo content is in English: skills, agents, docs, comments, commit subjects, CHANGELOG.
- One-line Conventional Commit subjects, no body. One concern per commit.
- Every user-facing commit adds its own line to `CHANGELOG.md` (Keep a Changelog sections) in the same commit. Test-only and CI commits don't.
- No ADR numbers in code, comments or messages; explain the reason in words.
- No new hooks: behaviour goes in skills and agents. Fix existing hooks when they break.
- Before changing anything that depends on Claude Code behaviour, check the current docs (the `claude-doc` MCP server, `search_docs`) and keep the `file:line` in the MR or audit notes, not in the code.
- Tests build their fixtures in temp dirs; never depend on other checkouts on the machine.

## Release

Releases are untagged: follow "Versioning and releases" in CONTRIBUTING.md. Merge only when the user says so.

## Known gotchas

- Managed settings lock the name `mastersoft`: test local changes with `scripts/dev.sh`, which loads a copy named `mastersoft-dev`.
- Run e2e checks headless with `--permission-mode default` (auto mode hides the prompts) and read `permission_denials` in the result. A prompt is a plugin bug when the plugin causes it: a command form a skill prescribes, a file the plugin reads outside the working directory. `git -C`, `cd … &&`, `$(…)`, `grep '…$'` and agents that go to the background under `-p` are Claude Code defaults.
- A plugin agent's Read of `${CLAUDE_PLUGIN_ROOT}/…` always asks for approval: agents have no `allowed-tools`, so their reference material lives in the agent file.
- A skill's `allowed-tools` grant lasts only the turn that loads it, and a Bash rule matches only the exact command form the skill tells the model to run.
- A settings `env` with `MASTERSOFT_SKIP_PUSH_CHECK=1` turns the push gate off: override it with `--settings '{"env":{"MASTERSOFT_SKIP_PUSH_CHECK":"0"}}'` when testing it.
