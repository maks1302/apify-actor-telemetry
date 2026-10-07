# Actor integration and lifecycle

The core owns sanitization, configuration, identity, logger history, async context, occurrence deduplication, and delivery. The Actor owns retries, classification, terminal outcomes, cleanup, persistence, and exit policy.

Initialize telemetry early in the entry point, supplying identity, schema, and the existing logger. Static imports execute before entry-point statements; move failure-prone business initialization into a protected callback where practical. Do not claim coverage of code that runs before the instance exists.

## Actor.main

Use `runActorMain(Actor, telemetry, callback, options?)` as shown in the [README](../README.md). It lets `Actor.main()` own init/exit, attaches telemetry lifecycle listeners after initialization inside the callback, captures callback failures before the SDK catches them, flushes, and rethrows the original value. Existing SDK options are forwarded. Do not attach the same lifecycle separately. Process-level handlers are not installed by this helper.

## Explicit init/exit

```js
import { Actor } from 'apify';
import log from '@apify/log';
import { createActorTelemetry } from 'actor-telemetry-provisional';
import { attachActorLifecycle, exitActor, loadActorInput } from 'actor-telemetry-provisional/apify';

const telemetry = createActorTelemetry({ actorName: 'my-actor', actorVersion: '1.0.0', logger: log });
try {
    await Actor.init();
    attachActorLifecycle(Actor, telemetry); // Must follow successful init.
    const input = await loadActorInput(Actor, telemetry);
    // Register secrets, normalize input, and perform the Actor's existing work here.
    telemetry.setNormalizedInput(input);
} catch (error) {
    // The Actor's required persistence/cleanup belongs here before its terminal API.
    await exitActor(Actor, telemetry, {
        error,
        context: { operation: 'actor_run', errorCategory: 'internal' },
        exitOptions: { exitCode: 1 },
    });
    throw error; // Preserve failure if a test double/SDK option makes exit return.
}
// Preserve required success cleanup before exit as well.
await exitActor(Actor, telemetry, { reason: 'normal_completion', exitOptions: { exitCode: 0 } });
```

This example demonstrates ordering, not a replacement for an Actor's cleanup policy or specific failure classification. `exitActor` does not initialize the SDK or perform business cleanup. It captures the supplied application error with final outcome, flushes, and calls `Actor.exit()`. Default exit code is 1 when an `error` property is supplied and 0 otherwise. Explicit `exitOptions` are forwarded unchanged, so supply the intended code. Existing deliberate success exits caused by application failures can pass `exitCode: 0` while still reporting the original error. Do not silently change that policy during integration.

For `Actor.fail()` or another terminal method, capture the original failure and await a bounded flush before calling the existing method. Avoid awaiting reporting indefinitely. Do not swallow errors just because capture returned a failed status.

## Input ownership

`loadActorInput(Actor, telemetry, { env?, inputKey?, reference? }?)` first attempts `Actor.getValue(inputKey)`, then loads effective input with `Actor.getInput()`. The key defaults to `ACTOR_INPUT_KEY`, legacy `APIFY_INPUT_KEY`, then `INPUT`. Pass a custom SDK-configured key explicitly when it is not represented in those variables.

Stored input is snapshotted before SDK transformations. Failure to read stored input is marked unavailable; effective loading is still attempted and can succeed. An effective-input failure is annotated and rethrown, so the caller's terminal boundary captures it. The helper does not create a remote issue merely because stored input was unavailable.

Supply the schema and register decrypted/derived credentials immediately after loading. Reapply `setNormalizedInput` after Actor defaults or normalization. Custom loaders should call `setRawInput` on the actual original object before mutation, identifying its source. Never label already-transformed SDK input as unchanged stored input.

## Retry and capture boundaries

Use `withOperation` around each independent request/operation. Routine retries and recovery use local info/warning logs and breadcrumbs, not exception captures. The Actor chooses delay, retryability, attempts, and history. Capture once at the final unrecovered boundary, including Crawlee failed-request handlers or abandoned work that does not escape to the top level.

`annotate(error, originContext)` retains request/origin facts without replacing the Error. At the terminal boundary, pass explicit final `failure` and `progress` facts to `captureException`. Earlier annotations cannot override explicit `endedRun` or `shutdownReason`. Separate operation scopes distinguish deliberate reuse of one Error; use `occurrenceId` for distinct root occurrences. Non-Error throws are safely normalized, but use original Error objects where possible for stack and occurrence continuity.

Severity: debug for details, info for progress/recovery/routine retries, warning for recoverable degradation, error for unrecovered/terminal failures. Fatal is reserved for process-wide failures. Local logger error calls do not automatically create remote issues.

## Lifecycle and process ownership

`attachActorLifecycle` listens for aborting, migrating, and exit to record breadcrumbs and flush existing failures. It creates no application-error event for those lifecycle signals, does not call exit, and does not own persistence. Repeated attachment is idempotent; SDK event-manager changes cause rebinding. Detach/dispose removes only package-owned listeners from their original manager.

Do not dispose during migration preparation or periodic persistence. Dispose when the instance's ownership ends. Normal completion, user abort, configured limits, migration, and expected empty results are not failures; genuine previously encountered failures still require capture/flush.

`attachProcessHandlers()` is separate, opt-in, exclusive ownership of uncaught exceptions and unhandled rejections. Inspect existing handlers first. If another owner exists, integrate capture/flush into that owner's failure path; do not remove unrelated handlers to force installation. Package fatal handling captures, bounds delivery, and exits unsuccessfully; it is not a replacement for Actor persistence or graceful cleanup. Manual capture of the same Error occurrence coordinates with fatal reporting. Never rely on async process-exit listeners for delivery.

## Log coverage

Inject the actual supported shared logger. Its line-event extension preserves normal logging and censoring; remote sanitization is additional. Direct logger calls and the `telemetry.logger` adapter share that pipeline. Breadcrumbs are recent actions, not fabricated log lines. Concurrent operation breadcrumbs are isolated; run-level logger output can interleave. Console, subprocess, SDK output through other loggers, and platform messages are not guaranteed captured. No platform-log download is part of this adapter.
