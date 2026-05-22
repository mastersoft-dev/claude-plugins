# Brief Operations

## Create New Brief

1. Check if BRIEF.md already exists
2. If exists, ask user to confirm overwrite or update instead
3. Analyze the project structure (package.json, pubspec.yaml, pyproject.toml, etc.)
4. Infer tech stack and conventions from existing code
5. Generate BRIEF.md with discovered information
6. Ask user to fill in gaps (overview, current focus)

## Update Brief

1. Read existing BRIEF.md
2. Identify what needs updating based on user request
3. Preserve sections not being updated
4. Make targeted edits

## Review Brief

1. Read and summarize current BRIEF.md
2. Check if it's outdated (compare against actual project structure)
3. Suggest updates if needed

## Sync Dependencies

When package/dependency files change, update BRIEF.md's Tech Stack section.

**Watch these files:**

| File | Ecosystem |
|------|-----------|
| `package.json` | Node.js / JavaScript |
| `requirements.txt`, `pyproject.toml`, `setup.py` | Python |
| `pubspec.yaml` | Dart / Flutter |
| `Cargo.toml` | Rust |
| `go.mod` | Go |
| `Gemfile` | Ruby |
| `pom.xml`, `build.gradle` | Java |
| `composer.json` | PHP |
