# Risk Profile Escalations

## Profile-Specific Blockers

**Critical profile** (finance/banking) — treat these as blockers regardless of base severity:
- Any form of plaintext credential storage
- Missing certificate pinning on API calls
- Client-side-only validation for monetary operations
- Session tokens without expiry or rotation
- Missing audit trail for transactions
- Jailbreak/root detection absence on mobile

**High profile** (healthcare/PII) — treat these as blockers:
- PII logged to console, crash reports, or analytics
- Missing encryption for data at rest
- Absent or permissive data retention
- Missing access controls on patient/user records

**Elevated profile** (auth/SaaS) — treat these as blockers:
- Username enumeration via login/reset endpoints
- Missing rate limiting on auth endpoints
- CSRF on account-modifying operations
- OAuth state parameter missing or unchecked
