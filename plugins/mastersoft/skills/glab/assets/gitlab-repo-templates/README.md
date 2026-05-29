# GitLab Repo Templates — Drop-In

Copy these into your project so glab can pre-populate MR and issue bodies via `--template <name>`.

```
your-repo/
├── .gitlab/
│   ├── merge_request_templates/
│   │   ├── default.md
│   │   ├── bug_fix.md
│   │   └── feature.md
│   └── issue_templates/
│       ├── bug.md
│       ├── feature.md
│       ├── task.md
│       └── proposal.md
```

## Install

From the project root of the target repo:

```bash
mkdir -p .gitlab/merge_request_templates .gitlab/issue_templates
cp -R <claude-plugins>/plugins/mastersoft/skills/glab/assets/gitlab-repo-templates/merge_request_templates/* .gitlab/merge_request_templates/
cp -R <claude-plugins>/plugins/mastersoft/skills/glab/assets/gitlab-repo-templates/issue_templates/* .gitlab/issue_templates/
```

Commit and push. Templates are loaded **from the local repository only** — they must be committed to the branch glab reads.

## Use

```bash
# Default MR template
glab mr create --template default --title "..." --yes

# Bug-fix MR template
glab mr create --template bug_fix --title "fix: ..." --yes

# Bug issue
glab issue create --template bug --title "Something broke" --yes
```

`.md` extension is optional on `--template`.

## Quick-action lines

Each template ends with a `/label ~"type/..."` quick-action line that GitLab applies on submission. Remove the line if you'd rather pass `--label` on the CLI.
