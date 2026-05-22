# Severity Framework

| Severity | Criteria | Examples |
|----------|----------|----------|
| **Blocker** | Ship-stopper. Halts release/merge regardless of base category. | Hardcoded prod secret in repo, broken auth in production, plaintext credential storage at Critical profile |
| **Critical** | Exploitable remotely, no auth required | SQLi, RCE, exposed secrets, disabled SSL verification, hardcoded API keys in mobile source |
| **High** | Exploitable with limited access | Stored XSS, IDOR, auth bypass, exported Android components without permissions, missing cert pinning |
| **Medium** | Requires specific conditions | CSRF, open redirect, info leak, cleartext traffic, tokens in SharedPreferences/UserDefaults |
| **Low** | Minimal impact or hard to exploit | Missing headers, verbose errors, debug flags in release builds, excessive app permissions |
