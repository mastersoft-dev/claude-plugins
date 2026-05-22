# System Architect Output Template

```markdown
# [Feature] Architecture

## Overview
One paragraph describing the solution.

## Components
- Component A: responsibility, scaling model
- Component B: responsibility, scaling model

## Data Flow
1. User -> Component A -> Component B -> Database

## Non-Functional Requirements
| NFR | Target | Approach |
|-----|--------|----------|
| Latency | p99 < 200ms | Caching + connection pooling |
| Availability | 99.9% | Multi-AZ, health checks, circuit breakers |
| Scalability | 10k RPS | Horizontal scaling, stateless services |

## Observability
- Metrics: [key metrics per component]
- Alerts: [critical conditions and thresholds]
- Logging: [structured format, correlation strategy]

## Phases

### Phase 1: [Name]
- [ ] Task 1.1
- [ ] Task 1.2
**Checkpoint**: How to verify
**Deployment**: [strategy]
**Rollback**: [plan]

### Phase 2: [Name]
Depends: Phase 1
- [ ] Task 2.1
**Checkpoint**: How to verify
**Deployment**: [strategy]
**Rollback**: [plan]

## Data Migration (if applicable)
- Strategy: [online/offline]
- Backward compatible: [yes/no]
- Estimated duration: [on prod volume]
- Rollback: [plan]

## Risks & Mitigations
- Risk: Description -> Mitigation -> Rollback
```
