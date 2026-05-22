# Production Readiness

## Deployment Strategy

| Strategy | When to use | Rollback |
|----------|-------------|----------|
| **Rolling** | Stateless services, backward-compatible changes | Stop rollout, scale down new version |
| **Blue/green** | Database migrations, breaking changes | Switch traffic back to blue |
| **Canary** | High-risk changes, performance-sensitive | Route 100% back to stable |
| **Feature flags** | Gradual rollout, A/B testing | Disable flag |

Define which strategy applies to each phase of the plan.

## Data Migration

When schema or data changes are involved:

1. Can the migration run online (zero downtime) or does it need maintenance window?
2. Is the change backward compatible? (New code reads old data, old code reads new data)
3. What's the rollback plan if migration fails mid-way?
4. How long will migration take on production data volume?
5. Does it need a dual-write phase?

## Observability Plan

For each component, define:

- **Metrics**: Request rate, error rate, latency percentiles (p50/p95/p99), saturation (CPU, memory, connections)
- **Logs**: Structured logging with correlation IDs, log levels appropriate for production (no debug spam)
- **Traces**: Distributed tracing across service boundaries, span naming conventions
- **Alerts**: What conditions trigger pages? What's warning vs critical? Runbook links.

## Disaster Recovery

- **RTO** (Recovery Time Objective): How fast must we recover?
- **RPO** (Recovery Point Objective): How much data loss is acceptable?
- **Backup strategy**: What's backed up, how often, where stored, how tested?
- **Failover**: Automatic or manual? Multi-region? Database replicas?
