# Apify Actor telemetry

Shared exception reporting for independently built Node.js Apify Actors. The package keeps Sentry details out of scraping code and supplies sanitized input, Actor/run identity, recent logger output, operation context, and bounded delivery.

**Package:** `actor-telemetry-provisional` · **Version:** `0.1.1` · **ESM only** · **Node:** `>=20.19.0`

The official `@sentry/node` SDK is an internal dependency. Basic exception reporting can target Sentry or GlitchTip through `SENTRY_DSN`. The package does not provision monitoring projects or discover backend capabilities.

## Start here

- [API and configuration](docs/api.md): methods, context fields, budgets, and return statuses.
- [Actor integration](docs/integration.md): input, retries, lifecycle, and process ownership.
- [Testing and dependency upgrades](docs/testing-and-upgrades.md): mocked tests, smoke commands, and reproducible builds.
- [Guide for coding agents](docs/agent-guide.md): responsibilities and integration pitfalls.
- [New/existing Actor integration prompt](prompts/integrate-actor.md): copy into your coding agent.
- [Migration from direct Sentry prompt](prompts/migrate-legacy-monitoring.md): replace an older monitoring implementation.

## Install reproducibly

Use a verified immutable commit from this repository; the provisional name does not imply an npm registry release. Replace `VERIFIED_FULL_COMMIT_SHA` before running:

```sh
npm install --save-exact 'git+https://github.com/maks1302/apify-actor-telemetry.git#VERIFIED_FULL_COMMIT_SHA'
```

Honor your repository's installation requirements. Commit the manifest and lockfile together. Inject the Actor's existing SDK and logger; do not add a second Apify SDK installation. Supported optional peers are `apify >=3.5.3 <4` and `@apify/log >=2.5.28 <3`. Declared compatibility is not a claim that every version combination has been tested.

## Minimal Actor.main integration

```js
import { Actor } from 'apify';
import log from '@apify/log';
import { createActorTelemetry } from 'actor-telemetry-provisional';
import { loadActorInput, runActorMain } from 'actor-telemetry-provisional/apify';

// Supply the Actor's real version and input schema through its entry-point setup.
const telemetry = createActorTelemetry({
    actorName: 'my-actor',
    actorVersion: '1.0.0',
    inputSchema: { properties: { apiToken: { type: 'string', isSecret: true } } },
    logger: log,
});

await runActorMain(Actor, telemetry, async () => {
    const input = await loadActorInput(Actor, telemetry);
    telemetry.registerSecrets(input?.apiToken);
    const effectiveInput = { ...input, maxItems: input?.maxItems ?? 10 };
    telemetry.setNormalizedInput(effectiveInput);

    await telemetry.withOperation({ operation: 'save_results', errorCategory: 'storage' }, async () => {
        log.info('Saving results');
        telemetry.breadcrumb('results_ready', { count: 1 });
        await Actor.pushData({ example: true });
    });
});
```

This is a synthetic example. Replace its work with the Actor's existing business logic. The wrapper captures callback failures before `Actor.main()` handles them and attaches lifecycle listeners inside the initialized callback. It does not install process-level fatal handlers. Importing modules that can fail before telemetry creation still leaves a startup capture gap.

## Environment

Only `SENTRY_DSN` is needed to enable remote reporting. Missing or invalid configuration disables remote reporting safely and attempts one sanitized local warning.

| Variable | Behavior |
| --- | --- |
| `SENTRY_DSN` | Destination project; never commit a real DSN. Use one project per Actor. |
| `SENTRY_ENVIRONMENT` | `production`, `development`, or `test`; defaults to production on Apify Cloud and development locally. |
| `SENTRY_RELEASE` | Optional override; otherwise derived from supplied identity/version and available build metadata. |
| `SENTRY_FLUSH_TIMEOUT_MS` | Positive integer timeout; default 3000 ms, capped at 10000 ms. |

Apify identity variables are consumed automatically when available. Tests must pass an explicit test environment and mocked transport. No tracing, profiling, SDK log ingestion, or automatic global Sentry initialization is enabled.

## What is retained

Original input is independently snapshotted and sanitized; normalized input is separate. Oversized input has explicit omission/completeness metadata, with an available storage reference. Complete sanitized attachments require explicit, verified destination support. Later secret registration sanitizes retained data before transmission; it cannot retract data already sent.

Recent logs are the last 20 available lines emitted through the injected shared logger's supported line events, not the full platform log. Up to 50 recent-action breadcrumbs are retained with operation isolation. Retry policy and failure classification remain with the Actor.

## Smoke test

From this checkout, `npm run smoke` uses a mocked transport. A real synthetic event requires explicit authorization, a configured DSN, and `npm run smoke -- --send`. From an installed package, use `node node_modules/actor-telemetry-provisional/scripts/smoke.js` with the same optional flag. Never run remote smoke tests during ordinary builds or startup.

`accepted` means local SDK submission; `drained` means pending work drained. Neither confirms backend delivery. Reporting is best effort and cannot guarantee delivery after SIGKILL, OOM, abrupt termination, or network outage.
