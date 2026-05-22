# Data Flow and State

- Map every data path: creation -> transformation -> storage -> retrieval -> deletion
- Identify state boundaries: what's ephemeral vs persistent, local vs shared
- Define consistency requirements per boundary (strong, eventual, best-effort)
- Plan for schema evolution (additive changes, backward compatibility)
