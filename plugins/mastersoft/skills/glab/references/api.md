# glab — API Fallback

## Contents
- [Path placeholders](#path-placeholders)
- [Common operations](#common-operations)
- [`--field` vs `--raw-field`](#--field-vs---raw-field)

When a top-level glab subcommand doesn't expose what you need, drop to `glab api`. It uses the same stored auth — no manual token extraction needed.

## Path placeholders

These resolve from the current repo context:

| Placeholder | Resolves to |
|-------------|-------------|
| `:fullpath` | URL-encoded `group/subgroup/project` |
| `:id` | numeric project ID |
| `:branch` | current branch |
| `:user`, `:username` | authenticated user |
| `:namespace`, `:group`, `:repo` | parts of the project path |

## Common operations

**Edit an MR description:**

```bash
glab api --method PUT projects/:fullpath/merge_requests/<iid> \
  --field description="Updated body"
```

**Edit an issue title or body:**

```bash
glab api --method PUT projects/:fullpath/issues/<iid> \
  --field title="New title" --field description="New body"
```

**Bulk add labels to an issue:**

```bash
glab api --method PUT projects/:fullpath/issues/<iid> \
  --field add_labels="type/bug,topic/api"
```

**Paginated listing as NDJSON:**

```bash
glab api projects/:fullpath/issues --paginate --output ndjson \
  | jq 'select(.state == "opened")'
```

**GraphQL:**

```bash
glab api graphql -f query='
  query { project(fullPath: "group/subgroup/repo") { name, issuesEnabled } }
'
```

## `--field` vs `--raw-field`

- `--field key=value` — type-coerces booleans, numbers, `null` (`--field key:=null`).
- `--raw-field key=value` — always sends as string.
