# Migrate an Actor with direct Sentry monitoring

Replace `ACTOR_PATH`, then copy this prompt. It is deliberately scoped to one Actor at a time.

```text
Migrate the existing monitoring in the Apify Actor at ACTOR_PATH to the shared
core at https://github.com/maks1302/apify-actor-telemetry.git.
Current package name: actor-telemetry-provisional. Implement and test the migration.

Inspect applicable AGENTS.md, dependencies/lockfile, Node runtime, existing
monitoring modules/tests, logger, input loading, retries, caught errors, and Actor
lifecycle first. Inspect the selected core revision's package.json, exports,
declarations, implementation, tests, README, and integration guide. Use its actual
API and declared compatibility; do not assume undocumented features or an npm
registry release.

Scope changes to this Actor. Preserve scraping, billing, output, retryability,
backoff/counts, concurrency, cleanup, persistence, standby, and exit semantics.
Do not modify core code, Actor README/docs, publish/deploy, provision services, or
send real telemetry. Honor installation approval requirements. Pin a verified
immutable full Git commit and update the existing lockfile with the manifest;
verify the installed revision/version. Do not silently upgrade runtime/unrelated
dependencies, use a floating dependency, or install a second Apify SDK.

First map existing monitoring responsibilities to core APIs and Actor-owned facts.
Extract useful operation names, categories, request/retry history, progress, final
outcomes, and focused tests. Remove superseded direct Sentry initialization,
captures/scopes, sanitizers, input summaries, log interceptors, deduplication,
automatic integrations, and package-owned fatal handlers. Remove the direct SDK
dependency only if no legitimate remaining use exists. Preserve unrelated handlers
and business helpers; move Actor-specific retry policy out of monitoring without
changing its behavior. Avoid running legacy and core capture pipelines together.

Create one createActorTelemetry instance early in the entry point, explicitly
supplying actorName/version, actual secret-aware schema, and existing logger.
Keep any integration shim small. Business logic uses the core, never Sentry APIs.
Core owns configuration, identity/tags, sanitization, input completeness, bounded
logs/breadcrumbs, async context, occurrence deduplication, and delivery. Actor owns
classification/retries/outcomes and business/lifecycle behavior.

Let core read SENTRY_DSN, SENTRY_ENVIRONMENT, SENTRY_RELEASE, and
SENTRY_FLUSH_TIMEOUT_MS. DSN selects one project per Actor and supports basic
Sentry/GlitchTip reporting. Never hardcode providers/real credentials. Keep optional
features off, including attachments unless destination/version support was verified
and explicitly configured. Missing DSN must remain harmless. Use explicit test
environment AND mocked transport, ignoring ambient developer credentials.

Replace summarized or post-normalization raw input with an independent original
snapshot. Prefer /apify loadActorInput when compatible with existing semantics:
stored input first, effective SDK input second, respecting custom input keys.
For custom loading use setRawInput before mutation with honest source/reference;
mark unavailable via setRawInputUnavailable instead of mislabeling effective input.
Call setNormalizedInput after Actor normalization. Register decrypted/derived
secrets immediately; late registration cannot retract transmitted data. Preserve
ordinary input fields and let core report explicit oversized-input omissions.
Do not attach scraped records, entire environments, or summaries as original input.

Use withOperation for independent requests, annotate original errors at origin,
and captureException once at terminal failure boundaries. Use camelCase context:
operation, errorCategory, request {id,url,hostname,httpStatus,elapsedMs}, retry
{attempt,limit,history}, progress counters, failure {endedRun,abandonedOperation,
partialOutput,shutdownReason}, and bounded diagnostic data. Categories are
input_validation, authentication, rate_limit, upstream_api, network, parsing,
storage, internal, unknown. Explicit final capture facts override origin annotation
and inherited context; preserve request facts and origin breadcrumbs. Preserve
Errors/stacks/causes. Separate scopes distinguish reused Errors; use occurrenceId
for distinct root occurrences. Do not mutate global request context or fingerprints.
Default grouping remains; Actor-aware grouping only for deliberately shared projects.

Preserve supported logger output/censoring. Core retains up to 20 actual available
shared-logger lines and 50 operation-isolated breadcrumbs; this is not the entire
platform log. Do not replace console/stdout/stderr or invent log lines. Local logs
do not automatically create issues. Routine retries/recovery use info/warning
logs and breadcrumbs. Capture exhausted retries and abandoned operations once,
even when other requests continue; include history/progress/partial output.

Audit startup/init/input, existing catches and early returns, request and Crawlee
failed-request handlers, parsing/API/storage, graceful failures, and fatal paths.
Caught internal terminal failures need explicit capture. Protect failure-prone
startup work where practical; report any work before telemetry exists.

For Actor.main prefer /apify runActorMain and forward existing options; it owns
lifecycle attachment inside the initialized callback. For explicit init/exit,
create telemetry before init and attachActorLifecycle ONLY AFTER successful init.
Preserve Actor cleanup/persistence ownership. Use exitActor when compatible,
passing the original failure and explicit exitOptions matching existing status,
including deliberate successful failure exits. Otherwise capture/flush before the
existing terminal method. Reporting must not swallow errors or change exit policy.

Process capture is opt-in via attachProcessHandlers; inspect existing ownership,
avoid competing fatal handlers, and preserve unrelated ones. Coordinate through
an existing owner's capture/flush path when required. Fatal handling must terminate
unsuccessfully. Never rely on asynchronous exit listeners. Migration, user abort,
limits, empty results, and completion create no false errors; genuine failures
still flush. Do not dispose during migration preparation/periodic persistence.

Adapt useful old tests to exercise the real installed core through Actor wiring
with mocked transport, not a mock replacement for the package. Verify original/
normalized input ordering and mutation isolation, secrets, explicit completeness,
actual logger capture, retry recovery versus exhaustion, final outcome precedence
and retained origin breadcrumbs, catch/rethrow deduplication, concurrent isolation,
init/main/graceful failure capture, lifecycle attachment after init/cleanup,
nonfailure stops, missing DSN, backend failures, and bounded delivery. Use child
processes if testing fatal ownership. Run relevant repository checks.

Provide an Actor synthetic smoke script: mocked by default, real only with --send
and configured DSN, never executed remotely without explicit authorization. Use
the same package configuration/logger. In both modes, fail on capture not accepted
or flush not drained; also verify mocked submission count. Event ID/drained queue
is not proof of backend delivery. Delivery is best effort under outages, SIGKILL,
OOM, or abrupt termination.

Finish concisely with replaced legacy paths, preserved behaviors, checks, pinned
commit/version, env configuration, smoke commands, and specific remaining gaps.
Report any core deficiency separately with a reproducible scenario; do not bypass
the shared implementation with an Actor-local replacement.
```
