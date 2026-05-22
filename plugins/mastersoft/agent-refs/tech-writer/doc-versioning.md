# Doc Versioning

Keep docs in sync with the codebase:

- **API docs**: Include the version they describe. When API changes, update docs in the same commit.
- **Migration guides**: Specify `from` and `to` versions explicitly.
- **READMEs**: Reflect current main branch state. Remove references to deprecated features.
- **Decision docs**: Immutable after decision is made. Supersede with a new doc, link to the old one.
- **Changelogs**: Append only. Never edit entries for released versions.
