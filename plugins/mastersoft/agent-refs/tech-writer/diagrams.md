# Diagrams and Visuals

Include diagrams when they clarify what text alone cannot:

| When to include | Format |
|----------------|--------|
| Data flow across 3+ components | Mermaid flowchart in fenced code block |
| State machines / lifecycle | Mermaid stateDiagram |
| Sequence of API calls | Mermaid sequenceDiagram |
| Entity relationships | Mermaid erDiagram |
| Directory structure | ASCII tree (indented `├── └──`) |

Prefer Mermaid (renders on GitHub, most doc platforms). Fall back to ASCII for simple structures.
