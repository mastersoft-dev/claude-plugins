# glab — Worked Examples

## Contents
- [MR with a breaking change](#mr-with-a-breaking-change)
- [Issues](#issues)

## MR with a breaking change

**Breaking change — the one case for headed sections without an explicit request:**

```bash
glab mr create --fill --target-branch main \
  --title "refactor: switch session store from Postgres to Redis" \
  --label "type/refactoring,pr/breaking" \
  --description "Closes #87.

## Notes
Breaking: existing sessions are invalidated on deploy — coordinate with the mobile rollout." \
  --yes
```

## Issues

**Bug:**

```bash
glab issue create \
  --title "GeoFenceStateFactory duplicate key on signal-created rows" \
  --label "type/bug,topic/api" \
  --description "## Description
Factory raises IntegrityError when a signal creates a row before the factory runs.

## Reproduction
1. Send AP10 signal for a new device
2. Call init_geofence_states management command
3. Observe: duplicate key error on geofence_state table

## Environment
- Branch: main@a1b2c3d
- Python 3.12 / Django 5.1" \
  --yes
```

**Feature:**

```bash
glab issue create \
  --title "Geofence event generation + GeoFenceState tracking" \
  --label "type/feature,topic/api" \
  --description "## Goal
Generate enter/exit events when device signals cross geofence boundaries.

## Motivation
Core requirement for the alarm feed — no geofence events means no alerts.

## Acceptance Criteria
- [ ] Entry/exit events persisted on boundary crossing
- [ ] GeoFenceState tracks current in/out per device-geofence pair" \
  --yes
```
