# Public API

Import `createActorTelemetry` from `actor-telemetry-provisional`. Optional Apify helpers live under `actor-telemetry-provisional/apify`. TypeScript declarations ship with both exports. Business logic should use these APIs rather than Sentry scopes or event structures.

## Factory

`createActorTelemetry(options)` creates a private Sentry client without global initialization, automatic integrations, or process handlers. Provide one instance per Actor process. No Actor configuration files are read at import time.

| Option | Purpose |
| --- | --- |
| `actorName` | Required stable Actor identity. |
| `actorVersion` | Supplied version; default `0.0.0`. |
| `inputSchema` | Actor input schema, including `isSecret` properties. |
| `logger` | Existing supported Apify logger; optional for core-only use. |
| `env` | Environment snapshot; defaults to `process.env`. Tests must supply their own. |
| `transport` | Mock transport factory for tests; not a business-logic API. |
| `budgets` | Package policy limits in bytes; see below. |
| `capabilities.attachments` | `{ enabled: true, verified: true }` only after destination/version support is verified by the caller. |
| `actorAwareGrouping` | Default false. Optional Actor-aware grouping for deliberately shared projects. |

The DSN selects the project. The package does not infer capabilities from its hostname. Automatic metadata includes available Actor/run/task/build IDs, release, token-free Console run link, `APIFY_USER_ID`, and required tags. `APIFY_USER_IS_PAYING` is interpreted as `1` paying, `0` free, otherwise unknown; this is Apify paying status, not Actor revenue. Modern `ACTOR_*` metadata names are preferred, with legacy `APIFY_*` equivalents where implemented. Local execution does not require Cloud metadata.

## Methods

| Method | Contract |
| --- | --- |
| `setRawInput(value, { source?, reference? }?)` | Snapshot original parsed input before mutation/defaults. Supply an honest source and token-free storage reference. |
| `setRawInputUnavailable(reason, source?)` | Explicitly record missing/unreadable original input. The second argument has the same source/reference shape. |
| `setNormalizedInput(value)` | Separate snapshot of effective input. Call again after Actor normalization if needed. |
| `setProgress(countersOrCallback)` | Register live `processed`, `succeeded`, `failed`, and `saved` counters. Capture snapshots them synchronously. Pass `undefined` to unregister. |
| `registerSecrets(values)` | Register secret string values, including strings nested in arrays/objects; re-sanitize retained data at transmission. |
| `breadcrumb(message, data?, level?)` | Record a bounded recent action; default level `info`. Does not create an issue. |
| `withOperation(context, callback)` | Async-local context; returns the callback's result and annotates/rethrows failures without capturing them. |
| `annotate(error, context)` | Preserve origin facts; returns the original thrown value. Does not capture. |
| `annotateResponse(error, { httpStatus?, body? }, context?)` | Preserve an already-read JSON/text response under `operation.response`; returns the original error. No stream reads, logging, retries, or submission. |
| `captureException(error, context?)` | Capture an unrecovered failure; returns a promise of capture status. |
| `flush()` | Bounded pending delivery; returns a promise of flush status. |
| `dispose()` | Idempotent final cleanup, bounded flush/close, and removal of owned listeners/buffers. |
| `attachProcessHandlers()` | Opt-in exclusive fatal-process ownership; returns an idempotent detach function. Rejects conflicting fatal handlers. |

Read-only properties: `enabled`, `environment`, `release`, `flushTimeout`, and `logger`. The logger adapter preserves the injected logger's methods and normal output. Without a supported line-event source, logging can still work but excerpt availability is limited.

## Event context

```js
const context = {
    operation: 'fetch_page',
    errorCategory: 'upstream_api',
    request: { id: 'request-1', url: 'https://example.com/jobs', hostname: 'example.com', httpStatus: 503, elapsedMs: 800 },
    response: { httpStatus: 503, body: { message: 'Provider temporarily unavailable' } },
    retry: { attempt: 3, limit: 3, history: [{ attempt: 2, httpStatus: 503, reason: 'upstream unavailable', elapsedMs: 700 }] },
    progress: { processed: 10, succeeded: 8, failed: 2, saved: 8 },
    failure: { endedRun: false, abandonedOperation: true, partialOutput: true, shutdownReason: 'retry_exhausted' },
    diagnostic: { responseFormat: 'json' },
};
```

Use stable operation names. Supported categories: `input_validation`, `authentication`, `rate_limit`, `upstream_api`, `network`, `parsing`, `storage`, `internal`, `unknown`. The Actor supplies classification; the core does not infer retryability or categories from HTTP status.

Optional `level` accepts `error` or `fatal`; capture defaults to error. Optional `occurrenceId` distinguishes intentionally reused Error objects outside independent operation scopes. Keep dynamic identifiers out of exception messages and fingerprints.

Precedence is inherited operation context, then origin annotation, then explicit capture context. `request`, `retry`, `failure`, and `progress` merge in that order; explicit final outcome wins. Other fields are replaced by later values. Origin breadcrumbs survive parent/root re-annotation. The same Error object deduplicates within one occurrence; independent operation scopes represent independent occurrences. A failed local construction does not permanently mark the failure submitted.

## Failure responses and progress

`response` is supported both by `annotateResponse` and existing `annotate`/`withOperation`/`captureException` contexts. Bodies are snapshotted, redacted, and bounded separately from generic diagnostics. JSON bodies within budget remain structured, and text remains text, including empty strings. Oversized bodies become a useful text preview (serialized JSON for object bodies) ending in `[TRUNCATED]`. `response.completeness` supplies `complete`, `reason`, `truncated`, `format`, `sanitized_bytes`, and `limit_bytes` when applicable. Unavailable/unreadable bodies and total-event omission have explicit reasons. These byte counts describe the sanitized body, not wire bytes. Headers are not collected.

The Actor must read each response only once and retain the text or parsed JSON before validation. Pass it to `annotateResponse` on HTTP errors, JSON parse errors, schema/shape failures, or provider error payloads returned with HTTP 200. Report at the existing terminal boundary. Network failures without a response must not reuse a prior attempt's body: use a fresh error and per-attempt variable, or annotate with `{}` to explicitly mark a missing response. Recovered attempts do not create events merely by annotation.

Response capture does not automatically instrument HTTP clients or decide which payloads are errors. Do not pass streams, native fetch Responses, or Axios/got request/config objects. Existing business retry, output, and termination behavior remains Actor-owned. No response bodies are printed by the SDK. Later secret registration re-sanitizes outgoing bodies; a previously truncated preview is omitted if secret registration changed, because a partial secret may cross its boundary.

For progress, register an object whose counters the Actor already updates, or a synchronous callback returning a fresh four-counter snapshot. Each event contains `contexts.progress_completeness`, listing missing or invalid counters. Missing values are not fabricated as zero. Real zeros should be initialized by the Actor before work starts. Counters must be finite, nonnegative numbers; extra numeric counters are allowed. A bad source cannot prevent error submission. The live source supersedes older operation/origin progress; explicit `captureException(..., { progress })` values supersede the live source. Without a registered source, existing annotation/capture merge semantics are preserved. Counter units and increments remain Actor-owned; the SDK never counts failed retries as failed work or queries dataset metadata.

## Budgets and sanitization

These are conservative package policy limits, not claimed server limits. Values are clamped to safe bounds.

| Budget | Default | Allowed range |
| --- | --- | --- |
| `inputBytes` | 64 KiB | 1–128 KiB |
| `attachmentBytes` | 1 MiB | 1 KiB–5 MiB |
| `eventBytes` | 200 KiB | 160–256 KiB |
| `logLineBytes` | 1600 bytes | 128–4096 bytes |
| `logBytes` | 32 KiB | 1–64 KiB |
| `responseBytes` | 16 KiB | 128 bytes–64 KiB |

Raw input remains structurally complete when within budget, except secret redaction. Above the context budget, complete sanitized JSON can be attached only with explicitly enabled and verified attachment support, within the attachment budget. Otherwise it is omitted with completeness/size/reason/source/reference metadata. The attachment budget also caps retained raw input. Normalized input and diagnostic context are separately bounded. Total event budgeting can omit additional surfaces with explicit omission metadata.

Sensitive keys, schema secrets, registered values, credentials in URLs, authorization/cookies, messages, stacks, causes, logs, breadcrumbs, SDK data, and attachments pass through sanitization, including a final SDK hook. Ordinary original-input fields are preserved; this is not a blanket removal of personal data. Avoid supplying scraped records or entire environment objects. Caller-owned data is not mutated. Circular/oversized diagnostics are safely represented. Sanitization failure attempts a minimal safe event.

## Result semantics

Capture status is `accepted`, `duplicate`, `failed`, `disabled`, or `disposed`; an `eventId` may be present. Accepted means local construction and SDK submission, not backend acceptance. Flush/dispose status is `drained`, `timeout`, `failed`, or `disabled`. All results carry `backendDelivery: 'unconfirmed'`.

Flush failures include observed transport failures. A timeout bounds waiting; it cannot guarantee a destination stored the event. Final disposal can include multiple bounded phases. Monitoring failures must not determine business results or exit status.
