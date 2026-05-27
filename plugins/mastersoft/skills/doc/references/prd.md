---
type: prd
label: Product Requirements Document
filename: slug
dir: docs/prd
workflow: template-fill
title-prefix: "PRD"
status-values: [Draft, Review, Approved, Shipped, Cancelled]
default-status: Draft
active-statuses: [Draft, Review, Approved]
required-sections: [Status, Owner, Last updated, Goal, Non-goals, User stories, Success metrics, Constraints, Open questions, Linked artifacts]
short-fields: [Status, Owner, Last updated]
prose-fields: [Goal, Non-goals, User stories, Success metrics, Constraints, Open questions, Linked artifacts]
---

# PRD: {{title}}

- **Status**: {{status}}
- **Owner**: {{owner}}
- **Last updated**: {{last_updated}}

## Goal

{{goal}}

## Non-goals

{{non_goals}}

## User stories

{{user_stories}}

## Success metrics

{{success_metrics}}

## Constraints

{{constraints}}

## Open questions

{{open_questions}}

## Linked artifacts

{{linked_artifacts}}
