# Mobile Security (Android / iOS)

## Data Storage
- Flag plaintext secrets in SharedPreferences, UserDefaults, or NSUserDefaults
- Check for sensitive data in unencrypted SQLite/Realm databases
- Verify Keystore (Android) / Keychain (iOS) usage for credentials and tokens
- Scan for data leaking to app logs, backup archives, or clipboard

## Transport
- Verify certificate pinning implementation (OkHttp CertificatePinner, TrustKit, NSAppTransportSecurity)
- Flag disabled or bypassed SSL verification (TrustManager accepting all certs, `NSAllowsArbitraryLoads`)
- Check for cleartext traffic (HTTP) in `network_security_config.xml` or Info.plist

## Binary and Build
- Check for debug flags left enabled (`android:debuggable`, `DEBUG` preprocessor macros)
- Verify ProGuard/R8 obfuscation (Android) or bitcode stripping (iOS)
- Flag exported Activities/Services/ContentProviders without permission guards (Android)
- Check URL scheme handlers and universal/app links for input validation

## Platform-Specific
- **Android**: Review `AndroidManifest.xml` for over-permissioned declarations, exported components, intent filter hijacking, WebView `setJavaScriptEnabled` + `addJavascriptInterface` risks
- **iOS**: Review entitlements, App Transport Security exceptions, Keychain access groups, UIPasteboard exposure, background snapshot leaks

## Client-Side Logic
- Flag business logic or validation running only on client (bypassable)
- Check for token/session storage in insecure locations
- Verify deep link and custom scheme handlers sanitize parameters
