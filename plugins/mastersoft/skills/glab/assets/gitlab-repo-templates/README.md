# GitLab Repo Templates — Drop-In

Copy these into your project so the GitLab web UI offers them and the `glab` skill can read and fill them. They are deliberately thin: most MRs need only a title.

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

In the web UI, pick the template from the description dropdown. From the CLI, fill only the template's applicable lines and pass them via `--description` — `--template <name> --yes` submits the raw placeholder comments:

```bash
glab mr create --fill --target-branch main --title "fix: ..." --description "Closes #42" --yes
glab issue create --title "Something broke" --label "type/bug" --description "..." --yes
```

## Quick-action lines

Each template ends with a `/label ~"type/..."` quick-action line that GitLab applies on submission. Remove the line if you'd rather pass `--label` on the CLI.
