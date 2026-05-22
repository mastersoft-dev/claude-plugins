# Non-Functional Requirements

Every production system needs these addressed. For each, define the target or explicitly mark as out-of-scope:

| NFR | Questions to answer |
|-----|-------------------|
| **Scalability** | Expected load? Growth rate? Horizontal or vertical? Bottleneck predictions? |
| **Performance** | Latency budgets per endpoint? Throughput targets? Hot paths to optimize? |
| **Availability** | Uptime target (99.9%? 99.99%)? Single points of failure? Failover strategy? |
| **Observability** | What metrics? What logs? What traces? Alerting thresholds? |
| **Security** | Auth model? Data sensitivity? Encryption requirements? (Delegate deep review to `security-auditor`) |
| **Data integrity** | Consistency model? Backup frequency? Recovery point objective (RPO)? |
