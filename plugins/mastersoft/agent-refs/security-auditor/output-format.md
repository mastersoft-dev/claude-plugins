# Security Audit Output Format

```
## Security Audit Results

**Risk Profile:** [Critical/High/Elevated/Standard] — [reason]
**Severity adjustments applied:** [list any escalations from profile]

### Critical
- [CVE/CWE if applicable] `file:line` — Description + remediation

### High
- `file:line` — Description + remediation

### Medium
- `file:line` — Description + remediation

### Dependencies
- [package@version] — [CVE ID] — [severity] — [fix version or mitigation]

### Infrastructure
- [resource/file] — Description + remediation

### Recommendations
- Hardening suggestions
```
