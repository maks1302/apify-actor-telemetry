# Testing, smoke tests, and upgrades

## Safe tests

Always supply explicit environment configuration and a mocked transport, independent of ambient developer credentials:

```js
import { createActorTelemetry } from 'actor-telemetry-provisional';

let submissions = 0;
const telemetry = createActorTelemetry({
    actorName: 'test-actor',
    env: { SENTRY_ENVIRONMENT: 'test', SENTRY_DSN: 'https://synthetic@telemetry.invalid/1' },
    transport: () => ({
        send: async () => { submissions++; return { statusCode: 200 }; },
        flush: async () => true,
    }),
});
telemetry.setRawInput({ query: 'jobs' }, { source: 'synthetic_test' });
const capture = await telemetry.captureException(new Error('Synthetic failure'), {
    operation: 'synthetic_test', errorCategory: 'internal',
});
const flush = await telemetry.flush();
await telemetry.dispose();
if (capture.status !== 'accepted' || flush.status !== 'drained' || submissions !== 1) {
    throw new Error('Mock telemetry verification failed');
}
```

This transport is a test seam; production Actor code should not depend on Sentry envelope structure. Actor integration tests should exercise the installed package, not replace it with a mock that hides wiring mistakes. Focus on input ordering, logger wiring, retry exhaustion, final outcomes, concurrency, and lifecycle boundaries. Fatal-handler tests need child processes so termination can be verified safely.

From the core checkout, after dependencies are available:

```sh
npm test
npm run check:types
npm run check:pack
npm run smoke
```

`check:pack` creates a tarball in `artifacts`, unpacks it into an isolated temporary consumer, reuses existing Sentry dependencies without installation, and checks runtime imports, exports, mock smoke, and side effects. Set `TELEMETRY_TSC_PATH` to an existing TypeScript compiler JS entry file to also type-check the packed consumer. Without it, that optional declaration-consumer check is reported as unavailable. `check:types` independently checks source declarations when `tsc` is installed.

## Smoke commands

The default checkout command `npm run smoke` sends nothing remotely. Installed package command:

```sh
node node_modules/actor-telemetry-provisional/scripts/smoke.js
```

Only with explicit authorization and a configured `SENTRY_DSN`, add `--send` (checkout: `npm run smoke -- --send`). Do not place a real DSN in source, logs, shell examples, or committed files. The script returns unsuccessful status on failed capture/flush in either mode. A successful script still does not prove backend storage: check the destination UI separately if authorized. Never run remote smoke automatically at startup or during ordinary tests.

## Upgrade intentionally

Resolve and review a new immutable commit; update the Git dependency and lockfile together using the repository's approved installation workflow. Keep the installed package's declared version and resolved commit visible in the review. Run Actor integration checks against that installed revision, then rebuild/deploy the Actor through its normal authorized process.

Redeploying alone does not reliably update an old lockfile. A floating Git URL or `latest` assumption is not a reproducible upgrade strategy. Build caches and the lockfile can preserve the old resolution. Avoid deleting a lockfile as a shortcut, which can also change unrelated dependencies. Confirm the installed revision before testing or deployment.

Before a pilot, choose a destination project per Actor, configure the DSN securely, check supported Node/SDK/logger versions and process-handler ownership, and verify logger coverage. Attachments remain off unless destination/version support has been verified. Publishing a registry package, selecting a permanent name/version policy, deploying, and provisioning services are separate decisions.
