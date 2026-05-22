# Tea CLI — Common Workflows

## Fork & PR Flow

```bash
# 1. Fork upstream repo (if not already done)
tea repos fork --login=myinstance --repo=org/project

# 2. Clone your fork
tea clone org/project

# 3. Create feature branch, make changes, push
git checkout -b feature/my-change
# ... edit files ...
git add . && git commit -m "feat: add feature"
git push origin feature/my-change

# 4. Create PR targeting upstream main
tea pr create --base main --head feature/my-change --title "Add feature"

# 5. Monitor
tea pr list --state open
```

## PR Review Flow

```bash
# 1. List open PRs
tea pr list

# 2. Checkout PR locally for testing
tea pr checkout 42

# 3. Review, test, then approve or reject
tea pr approve 42
# or
tea pr reject 42

# 4. Merge (if authorized)
tea pr merge 42 --style squash

# 5. Clean up branches
tea pr clean 42
```

## Issue Triage Flow

```bash
# List open issues by label
tea issue list --state open --labels bug

# Assign and update
tea issue edit 15 --assignees @me

# Close when done
tea issue close 15
```

## Multi-Instance Flow

```bash
# Add multiple logins
tea login add --name=prod --url=https://gitea.company.com --token=xxx
tea login add --name=dev --url=http://localhost:3000 --token=yyy

# Set default
tea login default prod

# Override per-command
tea pr list --login dev
tea issue list --login prod
```

## CI/Actions Monitoring

```bash
# List recent workflow runs
tea actions runs list --status failed

# View specific run
tea actions runs view <run_id>

# Follow logs in real-time
tea actions runs logs <run_id> --follow
```

## JSON Output for Scripting

```bash
# Get PR data as JSON
tea pr list -o json

# Get issue data as JSON
tea issue list -o json --state all --limit 100
```
