# Integrate the shared package into an Actor

Replace `ACTOR_PATH` with the target repository path, then copy the text below. Choose a verified full commit during inspection; do not treat the provisional name as a published npm package.

```text
Integrate consistent error monitoring into the Apify Actor at ACTOR_PATH using
the existing shared package:
https://github.com/maks1302/apify-actor-telemetry.git

Implement the integration and focused tests, rather than only proposing changes.
The package's current name is actor-telemetry-provisional. Inspect the selected
revision's package.json, exports, declarations, source, tests, README, and guides.
Use its actual public API, not assumptions from this prompt or another revision.

Preserve scraping behavior, billing, outputs, retry policy, termination semantics,
cleanup, persistence, concurrency, and standby settings. Scope work to this Actor.
Do not modify the shared core, create/update Actor README/documentation files,
publish, deploy, provision services, or send real telemetry without separate
authorization. Honor applicable installation approval requirements.

1. Inspect and install reproducibly

Read applicable AGENTS.md, package.json, lockfiles, Node/runtime configuration,
logger usage, input loading, retries, caught failures, and lifecycle code first.
Check the selected core revision's declared Node, Apify SDK, and logger support.
Do not silently upgrade the Actor runtime or unrelated dependencies.

Reuse a compatible installed core when appropriate. Otherwise use the approved
installation workflow and pin the Git dependency to a verified immutable full
commit. Update package.json and its existing lockfile together. Verify the actual
installed commit and version; do not use a floating branch or assume npm latest.
Inject the Actor's existing Actor and logger instances, avoiding a second SDK.
Report concrete core API gaps separately instead of recreating core internals.

2. Architecture and initialization

Create one shared createActorTelemetry instance from the package root, supplying
actorName, actorVersion, actual inputSchema, and the existing supported logger.
Load identity/schema through the Actor entry-point configuration, not the core.
Create telemetry before Actor init, input loading, validation, and failure-prone
business initialization where practical. Static imports execute first: inspect
startup gaps and move appropriate initialization into protected boundaries.

Keep any Actor shim small: configuration and operation-specific wiring only.
Business logic must not import Sentry or use scopes, SDK tags/event structures,
global Sentry.init, direct SDK capture, another sanitizer, log buffer, or deduper.
Audit legacy monitoring and remove superseded initialization, handlers, logger
interception, and capture paths while preserving unrelated application handlers.

The core owns environment rules, identity/tags, sanitization/input completeness,
bounded logger history/breadcrumbs, async scopes, deduplication, and delivery.
The Actor owns operation/category facts, requests/retries/progress/final outcomes,
business behavior, cleanup, persistence, and exit policy.

3. Configuration and backend

Select the project/destination solely through SENTRY_DSN; never commit a real DSN
or hardcode a provider hostname. Use one project per Actor; actorName is identity,
not project creation or selection. Basic reporting must work with Sentry or
GlitchTip without provider-specific business logic.

Let the core read SENTRY_ENVIRONMENT, SENTRY_RELEASE, and SENTRY_FLUSH_TIMEOUT_MS.
Missing/invalid DSN must keep local logging and business behavior functional.
Keep tracing, profiling, SDK log ingestion, and optional capabilities disabled.
Attachments require explicit verified destination/version support through the
core API; hostname inference is insufficient. Do not bypass package budgets.

Tests must use an explicitly supplied test environment AND mocked transport,
independent of ambient credentials. Never send events from normal tests/startup.

4. Original input and secrets

Supply the actual secret-aware input schema. Prefer loadActorInput from /apify
when it matches the existing workflow: it reads stored input before effective
SDK input. Respect ACTOR_INPUT_KEY and custom SDK configuration, passing inputKey
explicitly when necessary. Do not alter defaulting, decryption, or transformations.

For custom loading, call setRawInput on the actual original parsed object before
mutation/defaults/filtering and identify its source/reference honestly. If stored
input is unavailable, call setRawInputUnavailable. Never label transformed SDK
input as unchanged stored input. A summary must not replace original input.

Call setNormalizedInput separately after Actor normalization. Register decrypted
and derived credentials via registerSecrets as soon as available, before relevant
diagnostics. Late registration protects retained/future data, not already sent
events. Do not attach scraped datasets, unrelated user records, or environment
objects. Let the package handle size limits, redaction, and storage references;
test explicit completeness/omission metadata rather than silent truncation.

5. Context, concurrency, and failure semantics

Use camelCase EventContext fields, according to the installed declarations:

{
    operation: 'fetch_page',
    errorCategory: 'upstream_api',
    request: { id, url, hostname, httpStatus, elapsedMs },
    retry: { attempt, limit, history },
    progress: { processed, succeeded, failed, saved },
    failure: { endedRun, abandonedOperation, partialOutput, shutdownReason },
    diagnostic: boundedOperationFacts,
}

Use stable operation names. Supported categories are input_validation,
authentication, rate_limit, upstream_api, network, parsing, storage, internal,
and unknown. Classification is Actor-owned; the core does not infer retryability.
Use application progress counters, not Dataset.getInfo() for final Cloud counts.
Let the core supply user identity and paying/free/unknown tier without fetching
profiles or reinterpreting APIFY_USER_IS_PAYING as Actor revenue.

Use withOperation around independent request/operation boundaries, never global
request tags. annotate preserves failure origin when rethrowing; final capture
supplies terminal outcome. Precedence is inherited context, origin annotation,
explicit capture context; final endedRun/shutdownReason must win while retaining
origin request facts and breadcrumbs. Preserve original Errors, stacks, causes.
Follow occurrence rules: independent scopes distinguish reused Error objects;
use occurrenceId where distinct root occurrences otherwise share one object.
Keep dynamic identifiers in context, not messages/fingerprints. Prefer default
grouping; actorAwareGrouping is opt-in only for deliberately shared projects.

6. Local logging, breadcrumbs, and retries

Preserve the supported shared logger and its censoring. Use that logger or the
telemetry.logger adapter as appropriate. Core capture covers up to 20 actual
available shared-logger lines, not the full platform log. Breadcrumbs describe
actions, not reconstructed lines; up to 50 are retained with operation isolation.
Do not add console/stdout/stderr patches or platform-log retrieval here.

Debug is detailed local diagnostics; info is progress/skips/recovery/routine
retries; warning is recoverable degradation; error is unrecovered/terminal
failure; fatal is optional process-wide failure. Local logs do not automatically
create remote issues. Preserve retryability, counts, delays, and backoff.
Record attempts through local logs, breadcrumbs, and retry context. Recovery
creates no issue; exhaustion captures the final failure once. Capture abandoned
operations even when other requests continue, with partial-output/progress facts.

7. Capture coverage and lifecycle ownership

Audit startup/init, input loading/validation, top-level callbacks, catches,
error-driven early returns, request handlers, final failed-request callbacks,
parsing/APIs, storage writes, graceful failures, and fatal process paths.
Apify/Crawlee may catch exceptions internally; explicitly capture terminal
failures that never reach the top-level boundary. Avoid duplicate intermediate
capture/rethrow/shutdown reports; do not broadly deduplicate independent failures.

For Actor.main, prefer runActorMain(Actor, telemetry, callback, options) from
/apify. It captures callback errors before SDK termination and attaches lifecycle
inside the already-initialized callback. Forward existing options; do not attach
the same lifecycle separately. Account for work before the protected callback.

For explicit init/exit, create telemetry before init, protect init failures, and
call attachActorLifecycle ONLY AFTER successful Actor.init(). The Actor retains
cleanup/persistence/init/exit ownership. Use exitActor only when its semantics fit.
Pass the original error for application-failure shutdown and explicit exitOptions
matching existing status policy, including deliberate exitCode: 0 when required.
For Actor.fail or other terminal APIs, capture and bounded-flush before invoking
the existing method. Do not swallow errors or silently change exit semantics.

Process capture is separate and opt-in through attachProcessHandlers. Inspect
existing fatal owners first; do not install competing handlers or remove unrelated
ones. If ownership conflicts, wire capture/flush into the existing owner instead.
Fatal paths must preserve unsuccessful termination. Do not rely on async exit
listeners. Use child-process tests if fatal handling is installed.

Normal completion, user abort, configured limits, expected empty results, and
migration must not generate false application errors, but must not suppress real
failures. Preserve persistence/cleanup and flush pending events on stop/migration.
Do not dispose on periodic persistence or temporary migration cleanup. Dispose
when telemetry ownership ends. Use bounded package helpers; backend failures
must not alter results, retry policy, or intended exit status.

8. Focused Actor integration tests

Exercise the real installed/pinned package through the integration with explicit
test configuration and mocked transport; do not mock away the package itself.
Test Actor-specific wiring rather than duplicating all core unit tests:
- Identity, operation/category, and local execution without Cloud metadata.
- Stored input before transformations, mutation isolation, normalized separation,
  schema/decrypted-secret redaction, and oversized-input completeness metadata.
- Actual supported logger output, ordering/bounds, and preservation of output.
- Recovery creates no issue; exhaustion/abandoned work captures final failure
  once with request/retry/progress/partial-output context.
- Catch/rethrow/shutdown deduplication and concurrent context isolation.
- Origin request facts AND breadcrumbs survive final outcome annotation.
- Actor.main/init failures capture before termination; explicit lifecycle attaches
  after init and cleans up without disturbing unrelated handlers.
- Graceful application failure reports even with deliberately successful exit.
- Abort/migration/limits/empty results/completion create no false events.
- Disabled monitoring, backend rejection, and bounded flush remain harmless.
Run the repository's appropriate checks; report unavailable checks honestly.

9. Smoke and completion

Provide an Actor-specific synthetic smoke script using the same configuration
and logger. Default to explicit test environment/mock transport. Real delivery
requires BOTH --send and configured SENTRY_DSN; do not run remotely without
explicit authorization. Include sanitized input, actual local logs, breadcrumbs,
and representative context. Fail the smoke command when capture is not accepted
or flush is not drained in EITHER mode; check mocked submission count as well.

Event IDs and queue drainage do not confirm backend delivery. Delivery is best
effort and cannot be guaranteed after SIGKILL, OOM, abrupt termination, or outage.

Finish with changes/checks, installed commit/version and compatibility, environment
variables, mocked/opt-in smoke commands, and concrete remaining capture/lifecycle/
backend/delivery limitations. Do not claim coverage or delivery beyond evidence.
```
