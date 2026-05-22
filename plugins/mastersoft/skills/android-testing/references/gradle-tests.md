# Gradle tests — Espresso, Compose Test, Robolectric, JUnit

Three test layers. Pick the lane that matches what the user is debugging.

| Layer | Where it runs | Speed | When to pick |
| --- | --- | --- | --- |
| **JVM unit (JUnit / Robolectric)** | Host JVM | seconds | Pure logic, ViewModels, repositories, anything that doesn't touch the framework hard. Robolectric stubs the framework so the same tests run without a device. |
| **Compose Test** | On-device or Robolectric | seconds–tens | Compose UI. Semantics-tree-aware; can act on `testTag` without `testTagsAsResourceId`. **Primary UI lane when the project includes `androidx.compose.ui:ui-test-junit4`.** |
| **Espresso / UIAutomator instrumentation** | On-device, in app process | tens of seconds | View-system UI, full activity flows, cross-app boundaries (uiautomator). |

## Detect Compose Test

```bash
grep -RsE 'compose\.ui:ui-test(-junit4)?' --include='build.gradle*' .
```

If this matches, the project is Compose-Test-ready. Prefer this lane over
uiautomator-driven exploration when the user owns the code.

## Build + install the latest APK before running tests or driving the UI

When testing or driving the **app under development from the current
codebase**, ensure the device runs the latest local build first. Stale
APKs cause silent false-pass / false-fail loops. Skip this only if the
user explicitly says "use the already-installed app" or "skip build".

```bash
# JVM unit + Robolectric — no install needed.

# Instrumentation tests on a connected device:
./gradlew :app:installDebug :app:installDebugAndroidTest \
    :app:connectedDebugAndroidTest

# Exploratory uiautomator walk against the app:
./gradlew :app:installDebug
adb -s "$SERIAL" shell am start -W -n com.example.app/.MainActivity
${CLAUDE_SKILL_DIR}/scripts/ui_snapshot.py --serial "$SERIAL"
```

`installDebug` is incremental — Gradle skips when sources unchanged, so
running it always is cheap. Add `-PinstallTimeout=60` if `adb install` is
flaky over USB. For multi-flavour projects, substitute the flavour-specific
task (`:app:installFooDebug`).

## Run commands

Always invoke through the project's wrapper (`./gradlew`), not a global
`gradle`. The wrapper pins the version.

### JVM unit tests

```bash
./gradlew :app:testDebugUnitTest                      # one variant
./gradlew test                                         # all modules, default variant
./gradlew :feature:home:testDebugUnitTest --tests \
    'com.example.home.HomeViewModelTest'               # a single test class
```

Reports land at `*/build/reports/tests/testDebugUnitTest/index.html`.
Failure XML at `*/build/test-results/testDebugUnitTest/*.xml` — useful for
machine parsing.

### Robolectric (still a JVM unit task)

Robolectric tests live in `src/test/` and run under the same task as JUnit.
Configure the SDK and qualifiers via `RobolectricTestRunner` annotations.
There is no separate Gradle task — `:app:testDebugUnitTest` runs them.

### Instrumentation tests (Espresso, UIAutomator, Compose Test on-device)

```bash
./gradlew :app:connectedDebugAndroidTest               # all instrumentation
./gradlew :app:connectedDebugAndroidTest \
    -Pandroid.testInstrumentationRunnerArguments.class= \
    com.example.LoginFlowTest                          # a single class
./gradlew :app:connectedDebugAndroidTest \
    -Pandroid.testInstrumentationRunnerArguments.package=com.example.flows
```

Reports at `*/build/reports/androidTests/connected/...`. Requires a healthy
device — use `scripts/device_pick.sh` first; honour `ANDROID_SERIAL`.

**After instrumentation, the app is uninstalled.** AGP's
`connectedAndroidTest` task removes the app + test APKs at the end of the
run regardless of pass/fail (`am instrument` cleanup). If you intend to
drive the UI manually right after a test run, **re-run `:app:installDebug`
before launching `MainActivity`** — `adb shell am start -n …/.MainActivity`
will otherwise fail with `Activity class … does not exist`.

**JDK version.** AGP 9.x requires JDK 21; AGP 8.x requires JDK 17. If
`./gradlew` fails with `Unsupported class file major version`, a wrong JDK
is on PATH. Resolve before invoking:

```bash
# macOS / Homebrew JDK 21:
export JAVA_HOME=/opt/homebrew/opt/openjdk@21
export PATH="$JAVA_HOME/bin:$PATH"

# Linux: pick the matching distro path, eg.
# export JAVA_HOME=/usr/lib/jvm/temurin-21-jdk-amd64
```

Prefer setting `org.gradle.java.home` in `~/.gradle/gradle.properties` for
durable selection across sessions.

**After instrumentation, the app is uninstalled.** AGP's
`connectedAndroidTest` task removes the app + test APKs at the end of the
run regardless of pass/fail (`am instrument` cleanup). If you intend to
drive the UI manually right after a test run, **re-run `:app:installDebug`
before launching `MainActivity`** — `adb shell am start -n …/.MainActivity`
will otherwise fail with `Activity class … does not exist`.

**JDK version.** AGP 9.x requires JDK 21; AGP 8.x requires JDK 17. If
`./gradlew` fails with `Unsupported class file major version`, a wrong JDK
is on PATH. Resolve before invoking:

```bash
# macOS / Homebrew JDK 21:
export JAVA_HOME=/opt/homebrew/opt/openjdk@21
export PATH="$JAVA_HOME/bin:$PATH"

# Linux: pick the matching distro path, eg.
# export JAVA_HOME=/usr/lib/jvm/temurin-21-jdk-amd64
```

Prefer setting `org.gradle.java.home` in `~/.gradle/gradle.properties` for
durable selection across sessions.

**After instrumentation, the app is uninstalled.** AGP's
`connectedAndroidTest` task removes the app + test APKs at the end of the
run regardless of pass/fail (`am instrument` cleanup). If you intend to
drive the UI manually right after a test run, **re-run `:app:installDebug`
before launching `MainActivity`** — `adb shell am start -n …/.MainActivity`
will otherwise fail with `Activity class … does not exist`.

**JDK version.** AGP 9.x requires JDK 21; AGP 8.x requires JDK 17. If
`./gradlew` fails with `Unsupported class file major version`, a wrong JDK
is on PATH. Resolve before invoking:

```bash
# macOS / Homebrew JDK 21:
export JAVA_HOME=/opt/homebrew/opt/openjdk@21
export PATH="$JAVA_HOME/bin:$PATH"

# Linux: pick the matching distro path, eg.
# export JAVA_HOME=/usr/lib/jvm/temurin-21-jdk-amd64
```

Prefer setting `org.gradle.java.home` in `~/.gradle/gradle.properties` for
durable selection across sessions.

**After instrumentation, the app is uninstalled.** AGP's
`connectedAndroidTest` task removes the app + test APKs at the end of the
run regardless of pass/fail (`am instrument` cleanup). If you intend to
drive the UI manually right after a test run, **re-run `:app:installDebug`
before launching `MainActivity`** — `adb shell am start -n …/.MainActivity`
will otherwise fail with `Activity class … does not exist`.

**JDK version.** AGP 9.x requires JDK 21; AGP 8.x requires JDK 17. If
`./gradlew` fails with `Unsupported class file major version`, a wrong JDK
is on PATH. Resolve before invoking:

```bash
# macOS / Homebrew JDK 21:
export JAVA_HOME=/opt/homebrew/opt/openjdk@21
export PATH="$JAVA_HOME/bin:$PATH"

# Linux: pick the matching distro path, eg.
# export JAVA_HOME=/usr/lib/jvm/temurin-21-jdk-amd64
```

Prefer setting `org.gradle.java.home` in `~/.gradle/gradle.properties` for
durable selection across sessions.

**After instrumentation, the app is uninstalled.** AGP's
`connectedAndroidTest` task removes the app + test APKs at the end of the
run regardless of pass/fail (`am instrument` cleanup). If you intend to
drive the UI manually right after a test run, **re-run `:app:installDebug`
before launching `MainActivity`** — `adb shell am start -n …/.MainActivity`
will otherwise fail with `Activity class … does not exist`.

**JDK version.** AGP 9.x requires JDK 21; AGP 8.x requires JDK 17. If
`./gradlew` fails with `Unsupported class file major version`, a wrong JDK
is on PATH. Resolve before invoking:

```bash
# macOS / Homebrew JDK 21:
export JAVA_HOME=/opt/homebrew/opt/openjdk@21
export PATH="$JAVA_HOME/bin:$PATH"

# Linux: pick the matching distro path, eg.
# export JAVA_HOME=/usr/lib/jvm/temurin-21-jdk-amd64
```

Prefer setting `org.gradle.java.home` in `~/.gradle/gradle.properties` for
durable selection across sessions.

**After instrumentation, the app is uninstalled.** AGP's
`connectedAndroidTest` task removes the app + test APKs at the end of the
run regardless of pass/fail (`am instrument` cleanup). If you intend to
drive the UI manually right after a test run, **re-run `:app:installDebug`
before launching `MainActivity`** — `adb shell am start -n …/.MainActivity`
will otherwise fail with `Activity class … does not exist`.

**JDK version.** AGP 9.x requires JDK 21; AGP 8.x requires JDK 17. If
`./gradlew` fails with `Unsupported class file major version`, a wrong JDK
is on PATH. Resolve before invoking:

```bash
# macOS / Homebrew JDK 21:
export JAVA_HOME=/opt/homebrew/opt/openjdk@21
export PATH="$JAVA_HOME/bin:$PATH"

# Linux: pick the matching distro path, eg.
# export JAVA_HOME=/usr/lib/jvm/temurin-21-jdk-amd64
```

Prefer setting `org.gradle.java.home` in `~/.gradle/gradle.properties` for
durable selection across sessions.

### Compose Test on Robolectric (no device needed)

If the project sets up `RobolectricTestRunner` for Compose:

```kotlin
@RunWith(AndroidJUnit4::class)
@Config(application = HiltTestApplication::class, sdk = [33])
class LoginScreenTest {
    @get:Rule val composeRule = createComposeRule()

    @Test fun signInButton_isVisible() {
        composeRule.setContent { LoginScreen() }
        composeRule.onNodeWithText("Sign in").assertIsDisplayed()
    }
}
```

Run via `./gradlew :feature:login:testDebugUnitTest`. No device needed.

## Writing tests — minimal recipes

### Espresso (Views)

```kotlin
@HiltAndroidTest
class LoginActivityTest {
    @get:Rule val rule = ActivityScenarioRule(LoginActivity::class.java)

    @Test fun typeEmail_andSubmit_routesToHome() {
        onView(withId(R.id.email)).perform(typeText("alice@example.com"))
        onView(withId(R.id.password)).perform(typeText("hunter2"))
        onView(withId(R.id.signin)).perform(click())
        onView(withId(R.id.home_root)).check(matches(isDisplayed()))
    }
}
```

### Compose Test (semantics-aware)

```kotlin
@get:Rule val composeRule = createAndroidComposeRule<LoginActivity>()

@Test fun loginFlow_succeeds() {
    composeRule.onNodeWithTag("email").performTextInput("alice@example.com")
    composeRule.onNodeWithTag("password").performTextInput("hunter2")
    composeRule.onNodeWithText("Sign in").performClick()
    composeRule.onNodeWithTag("home_root").assertIsDisplayed()
}
```

`testTag` works here regardless of `testTagsAsResourceId`. That opt-in is
only needed when uiautomator (outside the test process) needs to see the tag.

### UIAutomator (cross-app, system UI)

Useful for permission dialogs, app-pickers, settings:

```kotlin
val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
device.findObject(By.text("Allow")).click()
```

## Parsing failures

When `connectedAndroidTest` or `testDebugUnitTest` fails:

```bash
# Latest test XML (useful for machine parsing)
find . -path '*build/test-results/*.xml' -newer ./gradlew -print | head

# Latest HTML report (open in a browser)
find . -path '*build/reports/*/index.html' -newer ./gradlew -print | head

# Stack from the most recent failure
find . -path '*build/test-results/*/TEST-*.xml' -newer ./gradlew -exec \
    grep -l '<failure' {} \; | xargs -I{} sed -n '/<failure/,/<\/failure>/p' {}
```

For instrumentation crashes the **device** logcat is authoritative — use
`scripts/logcat_tail.sh --pkg <appPackage> --summarize-crashes` while the
test runs.

## Common Gradle flags

| Flag | Effect |
| --- | --- |
| `--info` | per-task progress (Gradle's own logs) |
| `--stacktrace` | full stack on Gradle failure (build script issues) |
| `--rerun-tasks` | force re-run even when up-to-date |
| `-x test` | skip the `test` task (e.g. only run `:app:assembleDebug`) |
| `--tests <pattern>` | filter to test classes/methods matching pattern |
| `--continue` | keep going past first failure (useful for full sweeps) |

## Multi-module hint

The skill should ask the user (or read `settings.gradle*`) which module to
target. Running `./gradlew test` at the root pulls **every** module's unit
tests — fine for CI, slow during iteration. Prefer `:module:testDebugUnitTest`.
