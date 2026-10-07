# Guide for coding agents

Read the selected revision's `package.json`, `src/index.d.ts`, `src/apify.d.ts`, implementation, and tests before integrating. These are the executable authority when another revision differs from this guide. The package is ESM, currently named `actor-telemetry-provisional`; do not assume an npm release or undocumented export.

For Actor work, read that repository's applicable `AGENTS.md` first. Use the [integration prompt](../prompts/integrate-actor.md) or [legacy migration prompt](../prompts/migrate-legacy-monitoring.md). Scope changes to the selected Actor; do not modify all Actors or the core as an incidental integration fix.

## Ownership

Core: environment/DSN validation, identity, required tags, sanitization, input snapshots and completeness, bounded logs/breadcrumbs, async context, occurrence deduplication, private Sentry client, delivery.

Actor: input-loading semantics and schema, operation/category facts, requests, retries, progress, final outcome, business behavior, billing/output, persistence, cleanup, intended exit status.

Do not recreate core features in an Actor shim. Do not add direct Sentry imports, global init, another sanitizer/log buffer/deduper, or overlapping fatal handlers. Preserve unrelated handlers when removing legacy monitoring.

## Critical checks

- Create telemetry before protected startup work; explicitly report remaining pre-initialization gaps.
- With explicit init, attach lifecycle only after successful `Actor.init()`. With `runActorMain`, let its initialized callback own attachment.
- Capture original stored input before SDK/Actor transformations when feasible. Mark unavailable honestly; normalized input is separate.
- Register decrypted credentials early. Late registration only protects retained/future transmission.
- Routine retries create no remote issue. Capture terminal caught failures, including Crawlee failures, once with final outcome.
- Pass camelCase context fields. Explicit capture context wins over annotations; preserve original Error and origin breadcrumbs.
- Use independent operation scopes, not global request tags; use explicit occurrence IDs where reused root Errors represent different failures.
- Do not call logger output the full platform log. Retain actual available line events only.
- Preserve exit status and cleanup. Application failures need reporting even when the existing exit code is deliberately zero.
- Do not dispose on migration or periodic persistence. Fatal process ownership is opt-in and must preserve unsuccessful termination.
- Test through the real installed package using an explicit test environment/mock transport. Check smoke exit status for both capture and flush.
- Event IDs and queue drainage do not establish confirmed backend delivery.

If a core API gap prevents correct integration, report the exact gap and a reproducible failing scenario instead of bypassing the package. Repository maintenance should keep declarations, examples, prompts, and packaged-file checks consistent with implementation. Do not publish, deploy, install dependencies, or send remote telemetry without the required authorization.
