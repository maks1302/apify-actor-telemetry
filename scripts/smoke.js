#!/usr/bin/env node
import { createActorTelemetry } from '../src/index.js';
const send = process.argv.includes('--send');
if (send && !process.env.SENTRY_DSN) throw new Error('--send requires SENTRY_DSN');
let count = 0;
const telemetry = createActorTelemetry({ actorName: 'telemetry-synthetic-consumer', actorVersion: '0.1.0',
    env: send ? process.env : { SENTRY_DSN: 'https://synthetic@telemetry.invalid/1', SENTRY_ENVIRONMENT: 'test' },
    ...(send ? {} : { transport: () => ({ send: async () => { count++; return { statusCode: 200 }; }, flush: async () => true }) }) });
telemetry.setRawInput({ synthetic: true, ordinary: ['retained'], password: 'synthetic-secret' });
const capture = await telemetry.withOperation({ operation: 'synthetic_smoke', errorCategory: 'internal' }, () => telemetry.captureException(new Error('Synthetic telemetry smoke failure')));
const flush = await telemetry.flush();
await telemetry.dispose();
console.log(JSON.stringify({ mode: send ? 'remote_opt_in' : 'mock_only', capture, flush, ...(send ? {} : { events: count }) }));
if (capture.status !== 'accepted' || flush.status !== 'drained' || (!send && count !== 1)) process.exitCode = 1;
