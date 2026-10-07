// Adapted from google-map-scrapper-apify/test/monitoring.test.js; Actor business tests remain in their original repository.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Sentry from '@sentry/node';
import log, { LoggerJson } from '@apify/log';
import { createActorTelemetry } from '../src/index.js';
import { attachActorLifecycle, loadActorInput, runActorMain, exitActor } from '../src/apify.js';
const dsn = 'https://synthetic@telemetry.invalid/1';
const env = { SENTRY_DSN: dsn, SENTRY_ENVIRONMENT: 'test', SENTRY_FLUSH_TIMEOUT_MS: '40' };
function setup(t, extra = {}) {
    const events = [], envelopes = [], output = [];
    class RecordingLogger extends LoggerJson { _outputWithConsole(level, line) { output.push(line); } }
    const source = new RecordingLogger({ skipTime: true });
    const logger = log.child({ logger: source });
    const telemetry = createActorTelemetry({ actorName: 'synthetic-actor', actorVersion: '1.2.3', logger,
        ...extra, env: { ...env, ...extra.env }, transport: extra.transport || (() => ({ send: async (envelope) => { envelopes.push(envelope); for (const [header, payload] of envelope[1]) if (header.type === 'event') events.push(payload); return { statusCode: 200 }; }, flush: async () => true })) });
    t.after(() => telemetry.dispose());
    return { telemetry, events, envelopes, logger, source, output };
}

test('identity, complete original/normalized input, actual chronological last 20 logs and capture-time snapshot', async (t) => {
    const { telemetry: m, events, logger, source, output } = setup(t, { env: { APIFY_USER_IS_PAYING: '1', APIFY_USER_ID: 'user', ACTOR_ID: 'actor', ACTOR_RUN_ID: 'run', ACTOR_TASK_ID: 'task', ACTOR_BUILD_ID: 'build', ACTOR_BUILD_NUMBER: '42', ACTOR_DEFAULT_KEY_VALUE_STORE_ID: 'store' } });
    const raw = { ordinary: { values: [false, null, 12] }, longArray: Array(150).fill('yes'), urls: ['https://example.com/?q=a%20b#ordinary'], password: 'secret-value' };
    m.setRawInput(raw); raw.ordinary.values.push('mutation'); m.setNormalizedInput({ ...raw, defaults: true });
    m.breadcrumb('request started');
    const unrelated = () => {}; source.on('line', unrelated);
    for (let i = 0; i < 25; i++) logger.info(`actual line ${i}`);
    m.logger.error('triggering failure');
    const captured = m.captureException(new Error('failure secret-value'), { operation: 'save_results', errorCategory: 'storage', failure: { partialOutput: true }, progress: { saved: 2 } });
    m.setRawInput({ changed: true }); m.breadcrumb('later'); logger.info('after capture');
    assert.equal((await captured).status, 'accepted'); await m.flush();
    const event = events[0];
    assert.deepEqual(event.tags, { actor: 'synthetic-actor', customer_tier: 'paying', operation: 'save_results', error_category: 'storage' });
    assert.deepEqual(event.user, { id: 'user' }); assert.equal(event.environment, 'test'); assert.equal(event.release, 'synthetic-actor@1.2.3+42');
    assert.equal(event.contexts.actor_run.task_id, 'task'); assert.match(event.contexts.actor_run.console_run_url, /run$/);
    assert.deepEqual(event.contexts.raw_input.value.ordinary.values, [false, null, 12]); assert.equal(event.contexts.raw_input.value.longArray.length, 150);
    assert.deepEqual(event.contexts.raw_input.value.urls, raw.urls); assert.equal(event.contexts.normalized_input.value.defaults, true);
    assert.equal(event.contexts.input_completeness.complete, true);
    const lines = event.contexts.recent_logs.lines;
    assert.equal(lines.length, 20); assert.match(lines[0].text, /actual line 6/); assert.match(lines.at(-1).text, /triggering failure/); assert.ok(lines.every((line) => line.timestamp));
    assert.equal(output.length, 27); assert.deepEqual(event.breadcrumbs.map((b) => b.message), ['request started']); assert.ok(!JSON.stringify(event).includes('secret-value'));
    await m.dispose(); assert.deepEqual(source.listeners('line'), [unrelated]); source.off('line', unrelated);
});

test('local metadata, current and compatibility environment names, tier semantics', async (t) => {
    for (const [status, expected] of [['1', 'paying'], ['0', 'free'], ['true', 'unknown'], [undefined, 'unknown']]) {
        const { telemetry: m, events } = setup(t, { env: { APIFY_USER_IS_PAYING: status, APIFY_ACTOR_RUN_ID: 'legacy', APIFY_DEFAULT_KEY_VALUE_STORE_ID: 'store' } });
        await m.captureException('non-error', { operation: 'validate', errorCategory: 'input_validation' });
        assert.equal(events[0].tags.customer_tier, expected); assert.equal(events[0].user, undefined); assert.equal(events[0].contexts.actor_run.run_id, 'legacy'); await m.dispose();
    }
    const { telemetry: m, events } = setup(t); await m.captureException(42);
    assert.equal(events[0].contexts.actor_run.run_id, undefined); assert.equal(events[0].tags.operation, 'unknown'); assert.equal(events[0].contexts.operation.thrown_value, 42);
});

test('schema secrets, URL credentials, automatic exception stacks and causes, diagnostics, logs, breadcrumbs, late registration', async (t) => {
    const { telemetry: m, events, envelopes, output } = setup(t, { inputSchema: { properties: { nested: { properties: { ordinarySecret: { isSecret: true } } } } } });
    m.setRawInput({ ordinary: 'late-secret', nested: { ordinarySecret: 'schema-secret' }, encrypted: 'ENCRYPTED_VALUE:abc:def' });
    m.setNormalizedInput({ encrypted: 'decrypted-secret', ordinary: 'late-secret' });
    m.logger.info('late-secret https://user:pass@example.com/?token=url-secret');
    m.breadcrumb('late-secret', { authorization: 'Bearer auth-secret', url: 'https://example.com/?X-Amz-Signature=signed-secret' });
    const failure = new Error('stable late-secret', { cause: new Error('cause schema-secret password=inline-secret') });
    const result = m.captureException(failure, { request: { url: 'https://user:pass@example.com/?token=url-secret' }, diagnostic: { cookie: 'cookie-secret', payload: 'decrypted-secret', nestedUrl: 'https://example.com/?redirect=https%3A%2F%2Fu%3Ap%40example.com%2F%3Ftoken%3Dnested-secret' } });
    m.registerSecrets(['late-secret', 'decrypted-secret']); await result; await m.flush();
    const payload = JSON.stringify(envelopes);
    for (const secret of ['late-secret', 'schema-secret', 'decrypted-secret', 'inline-secret', 'url-secret', 'auth-secret', 'signed-secret', 'cookie-secret', 'nested-secret', 'user:pass', 'u:p', 'ENCRYPTED_VALUE']) assert.ok(!payload.includes(secret), secret);
    assert.equal(events[0].exception.values.length, 2); assert.ok(events[0].exception.values.every((v) => v.stacktrace.frames.length));
    assert.equal(events[0].contexts.raw_input.value.nested.ordinarySecret, '[REDACTED]');
    assert.ok(output[0].includes('late-secret'), 'normal logger pipeline preserved; outgoing SDK sanitized separately');
});

test('oversized input omission/storage reference and explicit verified complete JSON attachment', async (t) => {
    for (const capabilities of [{}, { attachments: { enabled: true, verified: false } }, { attachments: { enabled: true, verified: true } }]) {
        const { telemetry: m, events, envelopes } = setup(t, { capabilities, budgets: { inputBytes: 1024 }, env: { ACTOR_DEFAULT_KEY_VALUE_STORE_ID: 'store' } });
        m.setRawInput({ ordinary: 'x'.repeat(2000), late: 'secret-later' });
        const capture = m.captureException(new Error('large')); m.registerSecrets('secret-later'); await capture;
        assert.equal(events[0].contexts.raw_input, undefined);
        const attachments = envelopes[0][1].filter(([header]) => header.type === 'attachment');
        if (capabilities.attachments?.verified) { assert.equal(attachments.length, 1); const value = JSON.parse(Buffer.from(attachments[0][1]).toString()); assert.equal(value.ordinary.length, 2000); assert.equal(value.late, '[REDACTED]'); assert.equal(events[0].contexts.input_completeness.complete, true); }
        else { assert.equal(attachments.length, 0); assert.equal(events[0].contexts.input_completeness.complete, false); assert.match(events[0].contexts.input_completeness.reference, /records\/INPUT$/); }
        await m.dispose();
    }
});

test('circular/unavailable inputs explicit, ordinary sentinel preserved, oversized diagnostic/log bounds', async (t) => {
    const { telemetry: m, events } = setup(t, { budgets: { logLineBytes: 128, logBytes: 1024 } });
    m.setRawInput({ ordinary: '[CIRCULAR]' }); await m.captureException(new Error('first')); assert.equal(events[0].contexts.input_completeness.complete, true);
    const circular = { value: 'x'.repeat(10000) }; circular.self = circular;
    m.setRawInput(circular); m.logger.error('🧪'.repeat(2000)); await m.captureException(new Error('second'), { diagnostic: circular });
    assert.equal(events[1].contexts.raw_input, undefined); assert.equal(events[1].contexts.input_completeness.complete, false);
    assert.equal(events[1].contexts.operation.diagnostic.self, '[CIRCULAR]'); assert.match(events[1].contexts.operation.diagnostic.value, /TRUNCATED/);
    assert.ok(Buffer.byteLength(events[1].contexts.recent_logs.lines[0].text) <= 128); assert.equal(events[1].contexts.recent_logs.truncated, true);
});

test('routine retries only log; exhausted retry has origin plus final outcome and deduplicates at rethrow', async (t) => {
    const { telemetry: m, events } = setup(t);
    m.logger.info('retry recovered'); m.logger.warning('retry scheduled'); m.breadcrumb('retry', { attempt: 1 }); await m.flush(); assert.equal(events.length, 0);
    const failure = new Error('final failure');
    await m.withOperation({ operation: 'fetch', request: { id: 'one' } }, async () => {
        m.annotate(failure, { retry: { attempt: 3, limit: 3, history: [{ attempt: 1 }] }, failure: { endedRun: false, shutdownReason: 'old' } });
        await m.captureException(failure, { failure: { endedRun: true, shutdownReason: 'application_failure' } });
    });
    assert.equal((await m.captureException(failure)).status, 'duplicate'); assert.equal(events.length, 1);
    assert.equal(events[0].contexts.operation.failure.endedRun, true); assert.equal(events[0].contexts.operation.failure.shutdownReason, 'application_failure'); assert.equal(events[0].contexts.operation.retry.attempt, 3);
});

test('concurrent isolation, same reused Error in separate operations, root occurrence IDs', async (t) => {
    const { telemetry: m, events } = setup(t); const reused = new Error('stable error');
    await Promise.all(['first', 'second'].map((id) => m.withOperation({ operation: 'fetch', request: { id } }, async () => { m.breadcrumb(`action ${id}`); await new Promise((r) => setImmediate(r)); await m.captureException(reused); await m.captureException(reused); })));
    assert.equal(events.length, 2); for (const event of events) assert.deepEqual(event.breadcrumbs.map((b) => b.message), [`action ${event.contexts.operation.request.id}`]);
    await m.captureException(reused, { occurrenceId: 'fresh-one' }); await m.captureException(reused, { occurrenceId: 'fresh-two' }); assert.equal(events.length, 4);
});

test('failed local event construction remains retryable and never mutates original exceptions', async (t) => {
    const { telemetry: m, events } = setup(t); const failure = new Error('stable'); const stack = failure.stack;
    let broken = true; Object.defineProperty(failure, 'cause', { get() { if (broken) throw new Error('hostile getter'); return undefined; } });
    assert.equal((await m.captureException(failure)).status, 'failed'); broken = false;
    assert.equal((await m.captureException(failure)).status, 'accepted'); assert.equal(events.length, 1); assert.equal(failure.stack, stack);
});

test('private client leaves global SDK and process listeners unchanged; disposal idempotent', async (t) => {
    const client = Sentry.getClient(); const before = process.listeners('unhandledRejection');
    const { telemetry: m } = setup(t); const { telemetry: second } = setup(t);
    assert.equal(Sentry.getClient(), client); assert.deepEqual(process.listeners('unhandledRejection'), before);
    const dispose = m.dispose(); assert.equal(m.dispose(), dispose); await dispose; await second.captureException(new Error('independent'));
    assert.equal((await m.captureException(new Error('disposed'))).status, 'disposed');
});

test('lifecycle idempotence, persistence/migration remain usable, cleanup preserves unrelated listeners', async (t) => {
    const { telemetry: m, events } = setup(t); const actor = new EventEmitter(); const unrelated = () => {}; actor.on('aborting', unrelated);
    const detach = attachActorLifecycle(actor, m); assert.equal(attachActorLifecycle(actor, m), detach); assert.equal(actor.listenerCount('migrating'), 1);
    for (const event of ['aborting', 'migrating', 'exit']) await Promise.all(actor.listeners(event).map((fn) => fn()));
    assert.equal(events.length, 0); await m.captureException(new Error('real failure after migration')); assert.equal(events.length, 1);
    await m.dispose(); assert.deepEqual(actor.listeners('aborting'), [unrelated]); assert.equal(actor.listenerCount('migrating'), 0);
});

test('Actor.main callback and init failures report before SDK catch/exit; original error rethrown', async (t) => {
    const { telemetry: m, events } = setup(t); const failure = new Error('callback failure');
    const actor = new EventEmitter(); actor.main = async (callback) => { try { await callback(); } catch (error) { assert.equal(error, failure); assert.equal(events.length, 1); } };
    await runActorMain(actor, m, async () => { throw failure; }); assert.equal(events.length, 1);
    actor.main = async () => { throw new Error('init failed'); };
    await assert.rejects(() => runActorMain(actor, m, async () => {}), /init failed/); assert.equal(events.length, 2);
});

test('explicit exit captures original application failure despite successful exit, expected reasons only flush', async (t) => {
    const { telemetry: m, events } = setup(t); const options = { exitCode: 0, exit: false };
    const actor = { exit: async (received) => { assert.equal(received, options); } };
    for (const reason of ['normal_completion', 'user_abort', 'migration', 'configured_limit', 'empty_results']) await exitActor(actor, m, { reason, exitOptions: options });
    assert.equal(events.length, 0); await exitActor(actor, m, { error: new Error('application failure'), exitOptions: options });
    assert.equal(events.length, 1); assert.equal(events[0].level, 'error'); assert.equal(events[0].contexts.operation.failure.endedRun, true);
});

test('stored input helper snapshots before SDK mutation/decryption; failures explicitly unavailable', async (t) => {
    const { telemetry: m, events } = setup(t); const input = { original: true };
    await loadActorInput({ getValue: async () => input, getInput: async () => { input.defaults = true; return input; } }, m);
    await m.captureException(new Error('first')); assert.deepEqual(events[0].contexts.raw_input.value, { original: true }); assert.equal(events[0].contexts.normalized_input.value.defaults, true);
    await loadActorInput({ getValue: async () => { throw new Error('read failed'); }, getInput: async () => ({ fallback: true }) }, m);
    await m.captureException(new Error('second')); assert.equal(events[1].contexts.input_completeness.complete, false); assert.match(events[1].contexts.input_completeness.reason, /loading/);
    const failure = new Error('effective input failed'); await assert.rejects(() => loadActorInput({ getValue: async () => null, getInput: async () => { throw failure; } }, m), (e) => e === failure);
    await m.captureException(failure); assert.equal(events[2].tags.operation, 'load_input');
});

test('missing/invalid DSN warns once, no test transport disables, timeout config capped', async (t) => {
    for (const value of [undefined, 'invalid', 'https://telemetry.invalid/1']) {
        let warnings = 0; const m = createActorTelemetry({ actorName: 'test', env: { SENTRY_DSN: value, SENTRY_ENVIRONMENT: 'test' }, logger: { warning(message) { warnings++; assert.ok(!message.includes('https')); } } });
        await m.captureException(new Error('error')); await m.flush(); await m.dispose(); assert.equal(warnings, 1); assert.equal(m.enabled, false);
    }
    const m = createActorTelemetry({ actorName: 'test', env }); assert.equal(m.enabled, false); await m.dispose();
    const { telemetry } = setup(t, { env: { SENTRY_FLUSH_TIMEOUT_MS: '999999' } }); assert.equal(telemetry.flushTimeout, 10000);
});

test('backend rejection and stalled flush do not affect failure or exit semantics', async (t) => {
    const { telemetry: m } = setup(t, { transport: () => ({ send: async () => { throw new Error('network'); }, flush: () => new Promise(() => {}) }) });
    assert.equal((await m.captureException(new Error('failure'))).status, 'accepted');
    const start = Date.now(); const result = await m.flush(); assert.equal(result.status, 'failed'); assert.ok(Date.now() - start < 250); assert.equal(result.backendDelivery, 'unconfirmed');
    let exited = false; await exitActor({ exit: async () => { exited = true; } }, m, { error: new Error('second') }); assert.equal(exited, true);
});

test('logger without line extension reports unavailable coverage rather than fabricating lines', async (t) => {
    const { telemetry: m, events } = setup(t, { logger: { warning() {}, info() {} } }); m.logger.info('ordinary'); await m.captureException(new Error('failure'));
    assert.equal(events[0].contexts.recent_logs.available, false); assert.deepEqual(events[0].contexts.recent_logs.lines, []);
});

test('50 bounded breadcrumbs per isolated operation and safe event diagnostic budget', async (t) => {
    const { telemetry: m, events } = setup(t);
    await m.withOperation({ operation: 'fetch' }, async () => { for (let i = 0; i < 60; i++) m.breadcrumb(`action-${i}`); await m.captureException(new Error('failure'), { diagnostic: Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`field${i}`, 'x'.repeat(4000)])) }); });
    assert.ok(Buffer.byteLength(JSON.stringify(events[0])) <= 200 * 1024);
    await m.withOperation({ operation: 'next' }, () => m.captureException(new Error('second'))); assert.equal(events[1].breadcrumbs.length, 0);
    await m.withOperation({ operation: 'bounded' }, async () => { for (let i = 0; i < 60; i++) m.breadcrumb(`action-${i}`); await m.captureException(new Error('third')); });
    assert.equal(events[2].breadcrumbs.length, 50); assert.equal(events[2].breadcrumbs[0].message, 'action-10');
});

test('fatal uncaught/rejection delivery is bounded and unsuccessful; manual capture coordinates', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'telemetry-fatal-')); t.after(() => rm(directory, { recursive: true, force: true }));
    for (const mode of ['uncaught', 'rejection', 'manual-uncaught']) {
        const script = join(directory, `${mode}.mjs`), file = join(directory, `${mode}.json`);
        await writeFile(script, `import { appendFileSync } from 'node:fs';
import { createActorTelemetry } from ${JSON.stringify(new URL('../src/index.js', import.meta.url).href)};
const m = createActorTelemetry({ actorName: 'fatal-test', env: ${JSON.stringify(env)}, transport: () => ({ send: async (e) => { for (const [h,p] of e[1]) if(h.type === 'event') appendFileSync(${JSON.stringify(file)}, JSON.stringify(p)+'\\n'); return {statusCode:200}; }, flush: () => new Promise(() => {}) }) });
const detach = m.attachProcessHandlers(); if(m.attachProcessHandlers() !== detach) throw new Error('non-idempotent');
const error = new Error('synthetic fatal');
${mode.startsWith('manual') ? "await m.withOperation({operation:'fetch'}, () => m.captureException(error));" : ''}
${mode === 'rejection' ? 'Promise.reject(error);' : 'setImmediate(() => { throw error; });'}
`);
        await assert.rejects(() => promisify(execFile)(process.execPath, [script], { timeout: 2500 }), (e) => e.code === 1);
        const lines = (await readFile(file, 'utf8')).trim().split('\n'); assert.equal(lines.length, 1); assert.match(JSON.parse(lines[0]).exception.values[0].value, /synthetic fatal/);
    }
});

test('fatal handlers reject conflicts and remove only their owned handlers (isolated process)', async () => {
    const code = `
import assert from 'node:assert/strict';
import { createActorTelemetry } from ${JSON.stringify(new URL('../src/index.js', import.meta.url).href)};
const m = createActorTelemetry({actorName:'first', env:{}});
const other = createActorTelemetry({actorName:'second', env:{}});
const before = process.listeners('uncaughtException');
const detach = m.attachProcessHandlers(); assert.equal(m.attachProcessHandlers(), detach);
assert.throws(() => other.attachProcessHandlers(), /owner/);
const unrelated = () => {}; process.on('uncaughtException', unrelated);
detach(); assert.deepEqual(process.listeners('uncaughtException'), [...before, unrelated]);
assert.throws(() => other.attachProcessHandlers(), /Existing/);
process.off('uncaughtException', unrelated);
other.attachProcessHandlers(); await other.dispose(); await m.dispose();
assert.deepEqual(process.listeners('uncaughtException'), before);
`;
    await promisify(execFile)(process.execPath, ['--input-type=module', '-e', code], { timeout: 3000 });
});

test('schema secret paths preserve unrelated ordinary fields and operation annotations do not leak on reuse', async (t) => {
    const { telemetry: m, events } = setup(t, { inputSchema: { properties: { sensitive: { properties: { value: { isSecret: true } } } } } });
    m.setRawInput({ sensitive: { value: 'secret-one' }, ordinary: { value: 'ordinary-retained' } });
    const reused = new Error('failure');
    await m.withOperation({ operation: 'first', request: { id: 'first' } }, async () => { m.annotate(reused, { diagnostic: { privateToFirst: true } }); await m.captureException(reused); });
    await m.withOperation({ operation: 'second', request: { id: 'second' } }, async () => { m.annotate(reused, { errorCategory: 'network' }); await m.captureException(reused); });
    assert.equal(events[0].contexts.raw_input.value.ordinary.value, 'ordinary-retained'); assert.equal(events[0].contexts.raw_input.value.sensitive.value, '[REDACTED]');
    assert.equal(events[1].contexts.operation.diagnostic, undefined); assert.equal(events[1].contexts.operation.request.id, 'second');
});

test('safe fallback for hostile diagnostics retains error event and ordinary input', async (t) => {
    const { telemetry: m, events } = setup(t);
    m.setRawInput({ ordinary: true });
    const hostile = {}; Object.defineProperty(hostile, 'value', { enumerable: true, get() { throw new Error('getter secret'); } });
    const result = await m.captureException(new Error('stable failure'), { diagnostic: hostile });
    assert.equal(result.status, 'accepted'); assert.equal(events.length, 1); assert.equal(events[0].contexts.raw_input.value.ordinary, true); assert.ok(!JSON.stringify(events).includes('getter secret'));
});

test('SDK-incompatible DSNs are rejected before SDK can print credential-bearing configuration', async () => {
    let warnings = 0;
    const m = createActorTelemetry({ actorName: 'test', env: { SENTRY_DSN: 'https://invalid-key-with-dashes@telemetry.invalid/1', SENTRY_ENVIRONMENT: 'development' }, logger: { warning() { warnings++; } } });
    assert.equal(m.enabled, false); assert.equal(warnings, 1); await m.dispose();
});

test('real SDK transport against a local stalled server obeys delivery deadline without a remote event', async (t) => {
    const { createServer } = await import('node:http');
    const sockets = new Set(); const server = createServer(() => {});
    server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve)); });
    const m = createActorTelemetry({ actorName: 'local-transport', env: { SENTRY_DSN: `http://synthetic@127.0.0.1:${server.address().port}/1`, SENTRY_ENVIRONMENT: 'development', SENTRY_FLUSH_TIMEOUT_MS: '40' } });
    t.after(() => m.dispose());
    const start = Date.now(); assert.equal((await m.captureException(new Error('synthetic'))).status, 'accepted'); await m.flush(); await m.dispose(); assert.ok(Date.now() - start < 300);
});

test('late secrets cannot escape through prefixes truncated before registration', async (t) => {
    const { telemetry: m, events } = setup(t, { budgets: { logLineBytes: 128 } });
    const secret = 'unique-sensitive-prefix-'.repeat(500);
    m.logger.info('a'.repeat(100) + secret);
    const result = m.withOperation({ operation: 'failure', diagnostic: { value: secret } }, () => m.captureException(new Error('failure')));
    m.registerSecrets(secret); await result;
    assert.ok(!JSON.stringify(events).includes('unique-sensitive')); assert.match(events[0].contexts.recent_logs.lines[0].text, /REDACTED/);
    assert.match(events[0].contexts.operation.diagnostic.value, /TRUNCATED/);
});

test('withOperation retains failure origin when unwinding into final Actor boundary', async (t) => {
    const { telemetry: m, events } = setup(t); const actor = new EventEmitter();
    actor.main = async (callback) => { try { await callback(); } catch {} };
    const failure = new Error('failure');
    await runActorMain(actor, m, () => m.withOperation({ operation: 'fetch_page', errorCategory: 'upstream_api', request: { id: 'request' }, failure: { endedRun: false } }, async () => { m.breadcrumb('fetch started'); throw failure; }));
    assert.equal(events.length, 1); assert.equal(events[0].tags.operation, 'fetch_page'); assert.equal(events[0].contexts.operation.failure.endedRun, true); assert.deepEqual(events[0].breadcrumbs.map((b) => b.message), ['fetch started']);
});

test('nested operation unwinding preserves innermost failure origin without leaking into a separate operation', async (t) => {
    const { telemetry: m, events } = setup(t); const failure = new Error('failure');
    await assert.rejects(() => m.withOperation({ operation: 'outer' }, () => m.withOperation({ operation: 'inner', request: { id: 'inner' } }, async () => { throw failure; })), (e) => e === failure);
    await m.captureException(failure, { failure: { endedRun: true } }); assert.equal(events[0].tags.operation, 'inner');
    await m.withOperation({ operation: 'separate' }, () => m.captureException(failure)); assert.equal(events[1].tags.operation, 'separate'); assert.deepEqual(events[1].contexts.operation.request, {});
});

test('root progress/outcome annotations preserve request-local retry breadcrumbs and nested origin facts', async (t) => {
    const { telemetry: m, events } = setup(t);
    const failure = new Error('exhausted request');
    await assert.rejects(() => m.withOperation({ operation: 'fetch_page', request: { id: 'one' } }, async () => {
        m.breadcrumb('request started');
        m.annotate(failure, { request: { httpStatus: 503 }, retry: { attempt: 2, limit: 2 }, failure: { abandonedOperation: true } });
        m.breadcrumb('retry scheduled', { attempt: 1 }, 'warning');
        m.breadcrumb('retry exhausted', { attempt: 2 }, 'error');
        throw failure;
    }), (error) => error === failure);
    m.breadcrumb('unrelated root action');
    m.annotate(failure, { progress: { saved: 1 }, failure: { partialOutput: true } });
    m.annotate(failure, { progress: { processed: 2 }, failure: { endedRun: false, shutdownReason: 'origin' } });
    await m.captureException(failure, { failure: { endedRun: true, shutdownReason: 'application_failure' } });
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].breadcrumbs.map((action) => action.message), ['request started', 'retry scheduled', 'retry exhausted']);
    assert.deepEqual(events[0].contexts.operation.request, { id: 'one', httpStatus: 503 });
    assert.deepEqual(events[0].contexts.operation.progress, { saved: 1, processed: 2 });
    assert.deepEqual(events[0].contexts.operation.failure, { abandonedOperation: true, partialOutput: true, endedRun: true, shutdownReason: 'application_failure' });
});

test('parent-scope reannotation preserves inner history and a reused Error gets fresh operation breadcrumbs', async (t) => {
    const { telemetry: m, events } = setup(t);
    const failure = new Error('reused');
    await assert.rejects(() => m.withOperation({ operation: 'outer' }, async () => {
        m.breadcrumb('outer action');
        return m.withOperation({ operation: 'inner' }, async () => { m.breadcrumb('inner action'); throw failure; });
    }), (error) => error === failure);
    await m.captureException(failure);
    await m.withOperation({ operation: 'independent' }, async () => {
        m.breadcrumb('independent action');
        m.annotate(failure, { errorCategory: 'network' });
        await m.captureException(failure);
    });
    assert.deepEqual(events[0].breadcrumbs.map((action) => action.message), ['outer action', 'inner action']);
    assert.deepEqual(events[1].breadcrumbs.map((action) => action.message), ['independent action']);
    assert.equal(events[1].tags.operation, 'independent');
});

test('Actor.main lifecycle attaches after the actual SDK event-manager switch and cleans up the correct manager', async (t) => {
    const { Actor } = await import(process.env.TELEMETRY_APIFY_MODULE || 'apify');
    const actor = new Actor({ purgeOnStart: false });
    const oldManager = actor.config.getEventManager();
    const { telemetry: m } = setup(t);
    let flushes = 0;
    const originalFlush = m.flush;
    m.flush = () => { flushes++; return originalFlush(); };
    const options = { exit: false };
    actor.main = async (callback, receivedOptions) => {
        assert.equal(receivedOptions, options);
        assert.equal(oldManager.listeners('migrating').length, 0);
        // Use the same public SDK manager switch as Cloud Actor.init(), without network initialization.
        actor.config.useEventManager(actor.eventManager);
        actor.initialized = true;
        return callback();
    };
    const unrelated = () => {};
    actor.eventManager.on('migrating', unrelated);
    await runActorMain(actor, m, async () => {
        assert.equal(actor.eventManager.listeners('migrating').length, 2);
        actor.eventManager.emit('migrating');
        await actor.eventManager.waitForAllListenersToComplete();
        assert.equal(flushes, 1);
    }, options);
    assert.deepEqual(actor.eventManager.listeners('migrating'), [unrelated]);
    assert.equal(oldManager.listeners('migrating').length, 0);
    actor.eventManager.off('migrating', unrelated);
});

test('explicit lifecycle attachment rejects uninitialized SDK instances and static Actor facades', async (t) => {
    const { Actor } = await import(process.env.TELEMETRY_APIFY_MODULE || 'apify');
    const actor = new Actor({ purgeOnStart: false });
    const { telemetry: m } = setup(t);
    assert.throws(() => attachActorLifecycle(actor, m), /after successful Actor.init/);
    const facade = { getDefaultInstance: () => actor, on: actor.on.bind(actor), off: actor.off.bind(actor) };
    assert.throws(() => attachActorLifecycle(facade, m), /after successful Actor.init/);
    assert.equal(actor.config.getEventManager().listeners('migrating').length, 0);
    actor.config.useEventManager(actor.eventManager);
    actor.initialized = true;
    const detach = attachActorLifecycle(actor, m);
    assert.equal(actor.eventManager.listeners('migrating').length, 1);
    detach();
    assert.equal(actor.eventManager.listeners('migrating').length, 0);
});

test('lifecycle detach retains its original manager; reattachment after replacement is idempotent', async (t) => {
    const { telemetry: m } = setup(t);
    const oldManager = new EventEmitter(), newManager = new EventEmitter();
    let manager = oldManager;
    const actor = { initialized: true, config: { getEventManager: () => manager }, on: (...args) => manager.on(...args), off: (...args) => manager.off(...args) };
    const unrelated = () => {}; oldManager.on('migrating', unrelated);
    const oldDetach = attachActorLifecycle(actor, m);
    manager = newManager;
    const newDetach = attachActorLifecycle(actor, m);
    assert.notEqual(oldDetach, newDetach);
    assert.deepEqual(oldManager.listeners('migrating'), [unrelated]);
    oldDetach();
    assert.equal(attachActorLifecycle(actor, m), newDetach);
    await m.dispose();
    assert.equal(newManager.listenerCount('migrating'), 0);
    assert.deepEqual(oldManager.listeners('migrating'), [unrelated]);
});

test('bundled smoke reports unsuccessful status when opt-in reporting is disabled, without network transport', async () => {
    const script = new URL('../scripts/smoke.js', import.meta.url);
    await assert.rejects(() => promisify(execFile)(process.execPath, [script.pathname, '--send'], {
        timeout: 2500,
        env: { SENTRY_DSN: 'https://synthetic@telemetry.invalid/1', SENTRY_ENVIRONMENT: 'test' },
    }), (error) => {
        assert.equal(error.code, 1);
        const result = JSON.parse(error.stdout.trim());
        assert.equal(result.capture.status, 'disabled');
        assert.equal(result.flush.status, 'disabled');
        return true;
    });
});
