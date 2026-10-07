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
| `registerSecrets(values)` | Register secret string values, including strings nested in arrays/objects; re-sanitize retained data at transmission. |
| `breadcrumb(message, data?, level?)` | Record a bounded recent action; default level `info`. Does not create an issue. |
| `withOperation(context, callback)` | Async-local context; returns the callback's result and annotates/rethrows failures without capturing them. |
| `annotate(error, context)` | Preserve origin facts; returns the original thrown value. Does not capture. |
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
    retry: { attempt: 3, limit: 3, history: [{ attempt: 2, httpStatus: 503, reason: 'upstream unavailable', elapsedMs: 700 }] },
    progress: { processed: 10, succeeded: 8, failed: 2, saved: 8 },
    failure: { endedRun: false, abandonedOperation: true, partialOutput: true, shutdownReason: 'retry_exhausted' },
    diagnostic: { responseFormat: 'json' },
};
```

Use stable operation names. Supported categories: `input_validation`, `authentication`, `rate_limit`, `upstream_api`, `network`, `parsing`, `storage`, `internal`, `unknown`. The Actor supplies classification; the core does not infer retryability or categories from HTTP status.

Optional `level` accepts `error` or `fatal`; capture defaults to error. Optional `occurrenceId` distinguishes intentionally reused Error objects outside independent operation scopes. Keep dynamic identifiers out of exception messages and fingerprints.

Precedence is inherited operation context, then origin annotation, then explicit capture context. `request`, `retry`, `failure`, and `progress` merge in that order; explicit final outcome wins. Other fields are replaced by later values. Origin breadcrumbs survive parent/root re-annotation. The same Error object deduplicates within one occurrence; independent operation scopes represent independent occurrences. A failed local construction does not permanently mark the failure submitted.

## Budgets and sanitization

These are conservative package policy limits, not claimed server limits. Values are clamped to safe bounds.

| Budget | Default | Allowed range |
| --- | --- | --- |
| `inputBytes` | 64 KiB | 1–128 KiB |
| `attachmentBytes` | 1 MiB | 1 KiB–5 MiB |
| `eventBytes` | 200 KiB | 160–256 KiB |
| `logLineBytes` | 1600 bytes | 128–4096 bytes |
| `logBytes` | 32 KiB | 1–64 KiB |

Raw input remains structurally complete when within budget, except secret redaction. Above the context budget, complete sanitized JSON can be attached only with explicitly enabled and verified attachment support, within the attachment budget. Otherwise it is omitted with completeness/size/reason/source/reference metadata. The attachment budget also caps retained raw input. Normalized input and diagnostic context are separately bounded. Total event budgeting can omit additional surfaces with explicit omission metadata.

Sensitive keys, schema secrets, registered values, credentials in URLs, authorization/cookies, messages, stacks, causes, logs, breadcrumbs, SDK data, and attachments pass through sanitization, including a final SDK hook. Ordinary original-input fields are preserved; this is not a blanket removal of personal data. Avoid supplying scraped records or entire environment objects. Caller-owned data is not mutated. Circular/oversized diagnostics are safely represented. Sanitization failure attempts a minimal safe event.

## Result semantics

Capture status is `accepted`, `duplicate`, `failed`, `disabled`, or `disposed`; an `eventId` may be present. Accepted means local construction and SDK submission, not backend acceptance. Flush/dispose status is `drained`, `timeout`, `failed`, or `disabled`. All results carry `backendDelivery: 'unconfirmed'`.

Flush failures include observed transport failures. A timeout bounds waiting; it cannot guarantee a destination stored the event. Final disposal can include multiple bounded phases. Monitoring failures must not determine business results or exit status.
