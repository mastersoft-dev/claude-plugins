# Risk Profile Determination

Determine the project's risk profile before auditing. This controls which checks are mandatory vs advisory and whether severity should be escalated.

## Detection signals — infer profile from:
- BRIEF.md domain/description
- Package names (e.g., `com.bank.*`, healthcare libs, payment SDKs)
- Dependencies (Stripe, Plaid, FHIR, OAuth/OIDC providers)
- Regulatory markers in docs (GDPR, HIPAA, PCI-DSS, SOC2, PSD2)
- Context provided in the spawn prompt

## Profile table

| Profile | Trigger signals | Severity adjustment | Mandatory extras |
|---------|----------------|---------------------|------------------|
| **Critical** (finance, payments, banking) | Payment SDKs, PCI-DSS, PSD2, banking APIs | All Medium -> High, all High -> Critical | Cert pinning, encryption at rest, session timeout, anti-tampering, transaction signing, audit logging |
| **High** (healthcare, PII-heavy, gov) | HIPAA, FHIR, SSN/health data, gov contracts | Medium data-exposure -> High | Data encryption, access logging, consent checks, data retention policies |
| **Elevated** (auth/identity, SaaS, e-commerce) | OAuth providers, user accounts, payment forms | Auth-related Medium -> High | MFA flows, rate limiting, account enumeration prevention, CSRF on state-changing ops |
| **Standard** (internal tools, dashboards, CLIs) | No sensitive data flows, internal-only access | Default severity table | Standard OWASP checks |

When profile is unclear, default to **Elevated** and note the assumption.

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
