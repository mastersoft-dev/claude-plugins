# API Security

- Verify rate limiting on public and authenticated endpoints
- Check JWT validation: signature verification, expiry enforcement, audience/issuer checks, algorithm pinning (no `alg: none`)
- Review OAuth/OIDC flows: state parameter, PKCE for public clients, token storage, redirect URI validation
- Check API key handling: rotation capability, scoping, transport (header not URL)
- Flag missing pagination on list endpoints (DoS via unbounded queries)
- Verify error responses don't leak stack traces, internal paths, or version info
