import * as Sentry from '@sentry/node';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import * as http from 'node:http';
import * as https from 'node:https';
import { stripVTControlCharacters } from 'node:util';
import { createSanitizer } from './sanitize.js';

const categories = new Set(['input_validation', 'authentication', 'rate_limit', 'upstream_api', 'network', 'parsing', 'storage', 'internal', 'unknown']);
const clamp = (value, fallback, max, min = 1) => Number.isFinite(Number(value)) && Number(value) >= min ? Math.min(Math.floor(Number(value)), max) : fallback;
let processOwner;

// Private clients and empty integrations avoid global scopes, patching, and SDK fatal handlers.
export function createActorTelemetry({ actorName, actorVersion = '0.0.0', inputSchema = {}, logger, env = process.env, transport, budgets = {}, capabilities = {}, actorAwareGrouping = false } = {}) {
    if (typeof actorName !== 'string' || !actorName) throw new TypeError('actorName is required');
    env = { ...env };
    const scrub = createSanitizer(env, inputSchema);
    const local = new AsyncLocalStorage();
    const root = { id: 'run', context: {}, breadcrumbs: [], ancestors: [] };
    let annotations = new WeakMap();
    let submissions = new WeakMap();
    const pending = new Set();
    const cleanups = new Set();
    const logs = [];
    let droppedLines = 0;
    let disposed = false;
    let stoppedSending = false;
    let disposing;
    let client;
    let backendFailed = false;
    const flushTimeout = clamp(env.SENTRY_FLUSH_TIMEOUT_MS, 3000, 10000);
    const inputLimit = clamp(budgets.inputBytes, 64 * 1024, 128 * 1024, 1024);
    const attachmentLimit = clamp(budgets.attachmentBytes, 1024 * 1024, 5 * 1024 * 1024, 1024);
    const eventLimit = clamp(budgets.eventBytes, 200 * 1024, 256 * 1024, 160 * 1024);
    const lineLimit = clamp(budgets.logLineBytes, 1600, 4096, 128);
    const logLimit = clamp(budgets.logBytes, 32 * 1024, 64 * 1024, 1024);
    const attachmentEnabled = capabilities.attachments?.enabled === true && capabilities.attachments?.verified === true;
    const environment = ['production', 'development', 'test'].includes(env.SENTRY_ENVIRONMENT) ? env.SENTRY_ENVIRONMENT : env.APIFY_IS_AT_HOME === '1' ? 'production' : 'development';
    const platform = (name) => env[`ACTOR_${name}`] || env[`APIFY_ACTOR_${name}`]; // Legacy APIFY_ACTOR_* SDK names.
    const release = env.SENTRY_RELEASE || `${actorName}@${actorVersion}${platform('BUILD_NUMBER') || platform('BUILD_ID') ? `+${platform('BUILD_NUMBER') || platform('BUILD_ID')}` : ''}`;
    const store = env.ACTOR_DEFAULT_KEY_VALUE_STORE_ID || env.APIFY_DEFAULT_KEY_VALUE_STORE_ID;
    const metadata = { actor: actorName, actor_id: platform('ID'), actor_full_name: env.ACTOR_FULL_NAME, run_id: platform('RUN_ID'), task_id: platform('TASK_ID'), build_id: platform('BUILD_ID'), build_number: platform('BUILD_NUMBER'), release,
        console_run_url: platform('RUN_ID') ? `https://console.apify.com/actors/runs/${encodeURIComponent(platform('RUN_ID'))}` : undefined,
        input_storage_reference: store ? `https://api.apify.com/v2/key-value-stores/${encodeURIComponent(store)}/records/${encodeURIComponent(env.ACTOR_INPUT_KEY || env.APIFY_INPUT_KEY || 'INPUT')}` : undefined };
    const tier = env.APIFY_USER_IS_PAYING === '1' ? 'paying' : env.APIFY_USER_IS_PAYING === '0' ? 'free' : 'unknown';
    let raw;
    let normalized;
    let rawStatus = { complete: false, reason: 'input_not_read', source: 'unavailable' };
    let normalizedStatus;
    const state = () => local.getStore() || root;
    const bytes = (value) => Buffer.byteLength(JSON.stringify(value));
    function boundText(text, limit) {
        if (Buffer.byteLength(text) <= limit) return text;
        let end = Math.min(text.length, limit);
        while (Buffer.byteLength(text.slice(0, end) + '[TRUNCATED]') > limit) end--;
        return text.slice(0, end) + '[TRUNCATED]';
    }
    function onLine(line) {
        if (disposed) return;
        try {
            for (const part of stripVTControlCharacters(String(line)).split('\n')) {
                const clean = scrub.sanitizeText(part);
                logs.push({ text: boundText(clean, lineLimit), timestamp: new Date().toISOString(), secretVersion: scrub.secretVersion, truncated: Buffer.byteLength(clean) > lineLimit });
                while (logs.length > 20 || bytes(logs) > logLimit) { logs.shift(); droppedLines++; }
            }
        } catch { /* Logging remains independent. */ }
    }
    let logSource;
    try { logSource = logger?.getOptions?.().logger; } catch { /* Explicit unavailable coverage. */ }
    if (logSource?.on && logSource?.off) {
        logSource.on('line', onLine);
        cleanups.add(() => logSource.off('line', onLine));
    } else logSource = undefined;
    // Pass through the complete logger API and arguments; preserve its own censoring/filtering.
    const adaptedLogger = logger ? new Proxy(logger, { get(target, key) { const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; } }) : undefined;
    function inputSnapshot(value) {
        // Validate JSON independently: sentinel strings are ordinary values, not omissions.
        const encoded = JSON.stringify(value);
        if (encoded === undefined) throw new Error('not_json');
        const snapshot = JSON.parse(encoded);
        scrub.rememberInputSecrets(snapshot);
        let omitted = false;
        const safe = scrub.sanitize(snapshot, { complete: true, onOmission: () => { omitted = true; } });
        if (omitted) throw new Error('not_json');
        return safe;
    }
    function setRawInput(value, { source = 'caller_original_before_transformations', reference } = {}) {
        try { raw = inputSnapshot(value); const size = bytes(raw); rawStatus = { complete: true, source, reference, sanitized_bytes: size }; if (size > attachmentLimit) { raw = undefined; Object.assign(rawStatus, { complete: false, reason: 'input_exceeds_retention_budget', limit_bytes: attachmentLimit, reference: reference || metadata.input_storage_reference }); } }
        catch { raw = undefined; rawStatus = { complete: false, source, reference, reason: 'input_not_json_serializable' }; }
    }
    function setNormalizedInput(value) {
        try { normalized = inputSnapshot(value); normalizedStatus = { complete: true, source: 'caller_effective_input' }; if (bytes(normalized) > inputLimit) { normalized = undefined; Object.assign(normalizedStatus, { complete: false, reason: 'normalized_input_exceeds_budget' }); } }
        catch { normalized = undefined; normalizedStatus = { complete: false, reason: 'normalized_input_not_json_serializable' }; }
    }
    function snapshot(context, breadcrumbs) {
        const contexts = { actor_run: scrub.sanitize(metadata), operation: scrub.sanitize(context),
            recent_logs: { lines: scrub.sanitize(logs.map(({ secretVersion, ...line }) => ({ ...line, text: line.truncated && secretVersion !== scrub.secretVersion ? '[REDACTED: truncated log after secret registration]' : line.text }))), source: logSource ? '@apify/log:line' : 'unavailable', scope: 'shared_logger_only; excludes_console_subprocess_and_platform', available: Boolean(logSource), captured_at: new Date().toISOString(), truncated: droppedLines > 0 || logs.some((line) => line.truncated), max_lines: 20 },
            input_completeness: { ...rawStatus, limit_bytes: inputLimit } };
        const attachments = [];
        if (raw !== undefined) {
            const value = scrub.sanitize(raw, { complete: true });
            const size = bytes(value);
            contexts.input_completeness.sanitized_bytes = size;
            if (size <= inputLimit) contexts.raw_input = { value };
            else if (attachmentEnabled && size <= attachmentLimit) {
                attachments.push({ filename: 'raw-input.json', contentType: 'application/json', data: JSON.stringify(value) });
                Object.assign(contexts.input_completeness, { complete: true, delivery: 'attachment', attachment: 'raw-input.json' });
            } else Object.assign(contexts.input_completeness, { complete: false, reason: attachmentEnabled ? 'input_exceeds_attachment_budget' : 'input_exceeds_context_budget_attachments_unverified', reference: rawStatus.reference || metadata.input_storage_reference });
        }
        if (normalizedStatus) {
            contexts.normalized_input_completeness = { ...normalizedStatus, limit_bytes: inputLimit };
            if (normalized !== undefined) {
                const value = scrub.sanitize(normalized, { complete: true });
                if (bytes(value) <= inputLimit) contexts.normalized_input = { value };
                else Object.assign(contexts.normalized_input_completeness, { complete: false, reason: 'normalized_input_exceeds_budget' });
            }
        }
        return { contexts, attachments, secretVersion: scrub.secretVersion, breadcrumbs: scrub.sanitize(breadcrumbs.slice(-50)) };
    }
    function safeguard(event, hint) {
        try {
            const rawValue = event.contexts?.raw_input;
            const normalizedValue = event.contexts?.normalized_input;
            const safe = scrub.sanitize({ ...event, contexts: { ...event.contexts, raw_input: undefined, normalized_input: undefined } });
            if (rawValue) safe.contexts.raw_input = scrub.sanitize(rawValue, { complete: true });
            if (normalizedValue) safe.contexts.normalized_input = scrub.sanitize(normalizedValue, { complete: true });
            delete safe.request; delete safe.server_name;
            if (hint.data?.secretVersion !== scrub.secretVersion && safe.contexts?.recent_logs?.lines) safe.contexts.recent_logs.lines = safe.contexts.recent_logs.lines.map((line) => line.truncated ? { ...line, text: '[REDACTED: truncated log after secret registration]' } : line);
            safe.user = env.APIFY_USER_ID ? { id: scrub.sanitizeText(env.APIFY_USER_ID) } : undefined;
            if (bytes(safe) > eventLimit) {
                delete safe.extra;
                safe.breadcrumbs = [];
                delete safe.contexts.operation.diagnostic;
                safe.contexts.diagnostic_completeness = { complete: false, reason: 'event_budget_exceeded', limit_bytes: eventLimit };
                if (safe.contexts.normalized_input) { delete safe.contexts.normalized_input; Object.assign(safe.contexts.normalized_input_completeness, { complete: false, reason: 'event_budget_exceeded' }); }
                if (safe.exception?.values) safe.exception.values = safe.exception.values.map((value) => ({ ...value, value: boundText(value.value || '', 2048), stacktrace: { frames: (value.stacktrace?.frames || []).slice(-20).map((frame) => ({ filename: boundText(frame.filename || '', 512), function: boundText(frame.function || '', 256), lineno: frame.lineno, colno: frame.colno })) } }));
                if (bytes(safe) > eventLimit) {
                    const operation = safe.contexts.operation;
                    safe.contexts.operation = scrub.sanitize({ operation: operation.operation, errorCategory: operation.errorCategory, failure: operation.failure, progress: operation.progress, request: operation.request, retry: { attempt: operation.retry?.attempt, limit: operation.retry?.limit } });
                    while (safe.contexts.recent_logs.lines.length && bytes(safe) > eventLimit) { safe.contexts.recent_logs.lines.shift(); safe.contexts.recent_logs.truncated = true; }
                }
                if (bytes(safe) > eventLimit && safe.contexts.raw_input) { delete safe.contexts.raw_input; Object.assign(safe.contexts.input_completeness, { complete: false, reason: 'event_budget_exceeded', reference: metadata.input_storage_reference }); }

            }
            hint.attachments = attachmentEnabled ? (hint.attachments || []).flatMap((a) => {
                // Only package-owned JSON attachments can reach the SDK.
                if (a.filename !== 'raw-input.json' || typeof a.data !== 'string') return [];
                const data = JSON.stringify(scrub.sanitize(JSON.parse(a.data), { complete: true }));
                return Buffer.byteLength(data) <= attachmentLimit ? [{ ...a, data }] : [];
            }) : [];
            return safe;
        } catch {
            hint.attachments = [];
            return { event_id: event.event_id, level: 'error', message: 'Application error; diagnostic sanitization failed', tags: { actor: 'unknown', customer_tier: 'unknown', operation: 'unknown', error_category: 'unknown' } };
        }
    }
    let valid = false;
    try { const dsn = new URL(env.SENTRY_DSN); valid = ['http:', 'https:'].includes(dsn.protocol) && /^https?:\/\/\w+(?::\w*)?@(?:\[[:.%\w]+\]|[\w.-]+)(?::\d+)?\/(?:[^\s?#]+\/)?\d+$/.test(env.SENTRY_DSN) && !dsn.search && !dsn.hash; } catch { /* Disabled locally. */ }
    if (valid && (environment !== 'test' || transport)) {
        try {
            const factory = transport || Sentry.makeNodeTransport;
            client = new Sentry.NodeClient({ dsn: env.SENTRY_DSN, environment, release, transport: (options) => {
                const inner = factory({ ...options, bufferSize: 64, keepAlive: false, ...(transport ? {} : { httpModule: {
                    request(options, callback) {
                        const request = (options.protocol === 'https:' ? https : http).request(options, callback);
                        const timer = setTimeout(() => request.destroy(new Error('Telemetry transport deadline exceeded')), flushTimeout);
                        request.once('close', () => clearTimeout(timer));
                        return request;
                    },
                } }) });
                return { send(envelope) {
                    try { return Promise.resolve(inner.send(envelope)).then((response) => { if (!response || response.statusCode < 200 || response.statusCode >= 300) backendFailed = true; return response; }, () => { backendFailed = true; return { statusCode: 0 }; }); }
                    catch { backendFailed = true; return Promise.resolve({ statusCode: 0 }); }
                }, flush: (timeout) => inner.flush(timeout) };
            }, stackParser: Sentry.defaultStackParser, integrations: [], defaultIntegrations: false, enableLogs: false, sendDefaultPii: false, sendClientReports: false, includeServerName: false, enableOpenTelemetrySetup: false, enableRuntimeChannelInjection: false, tracesSampleRate: 0, spotlight: false, debug: false, normalizeDepth: 0, maxValueLength: Infinity, beforeSend: safeguard });
            client.init();
            // sendEvent is the official low-level submission API. This final hook applies even there.
            client.on('beforeSendEvent', (event, hint) => { const safe = safeguard(event, hint); for (const key of Object.keys(event)) delete event[key]; Object.assign(event, safe); });
        } catch { client = undefined; }
    }
    if (!client) { try { logger?.warning('Remote telemetry disabled: missing/invalid configuration or unavailable test transport.'); } catch { /* One safe warning attempt. */ } }
    function breadcrumb(message, data = {}, level = 'info') {
        if (disposed) return;
        const history = state().breadcrumbs;
        history.push(scrub.sanitize({ timestamp: Date.now() / 1000, category: 'actor.action', message, data, level }));
        if (history.length > 50) history.shift();
    }
    function withOperation(context, callback) {
        const parent = state();
        return local.run({ id: randomUUID(), context: { ...parent.context, ...scrub.sanitize(context) }, breadcrumbs: [...parent.breadcrumbs], ancestors: [...parent.ancestors, parent.id] }, () => {
            try {
                const result = callback();
                if (result && typeof result.then === 'function') return Promise.resolve(result).catch((error) => { annotate(error, {}); throw error; });
                return result;
            } catch (error) { annotate(error, {}); throw error; }
        });
    }
    function annotate(error, context) {
        if (error && (typeof error === 'object' || typeof error === 'function')) {
            const prior = annotations.get(error);
            const previous = prior && (prior.id === state().id || prior.ancestors?.includes(state().id) || state().id === 'run') ? prior : undefined;
            annotations.set(error, { id: previous && (state().id === 'run' || previous.ancestors?.includes(state().id)) ? previous.id : state().id, ancestors: previous?.ancestors || state().ancestors, context: { ...state().context, ...previous?.context, ...scrub.sanitize(context) }, breadcrumbs: [...state().breadcrumbs] });
        }
        return error;
    }
    async function constructException(error) {
        const event = await client.eventFromException(error, {});
        const seen = new Set([error]);
        let cause = error.cause;
        while (cause instanceof Error && !seen.has(cause) && seen.size < 6) {
            seen.add(cause);
            const child = await client.eventFromException(cause, {});
            event.exception.values.unshift(...child.exception.values);
            cause = cause.cause;
        }
        return event;
    }
    function captureException(thrown, context = {}) {
        if (disposed || !client) return Promise.resolve({ status: disposed ? 'disposed' : 'disabled', backendDelivery: 'unconfirmed' });
        const current = state();
        const object = thrown !== null && (typeof thrown === 'object' || typeof thrown === 'function');
        const saved = object ? annotations.get(thrown) : undefined;
        // Annotation describes origin. Capture fields describe final outcome and win, including nested fields.
        const origin = saved && (saved.id === current.id || saved.ancestors?.includes(current.id) || current.id === 'run') ? saved : undefined;
        const merged = { ...current.context, ...origin?.context, ...context };
        for (const key of ['request', 'retry', 'failure', 'progress']) merged[key] = { ...current.context[key], ...origin?.context[key], ...context[key] };
        const occurrence = context.occurrenceId || (origin?.id || current.id);
        const records = object ? submissions.get(thrown) : undefined;
        if (records?.has(occurrence)) return records.get(occurrence).then((result) => result.status === 'accepted' ? { ...result, status: 'duplicate' } : result);
        if (pending.size >= 64) return Promise.resolve({ status: 'failed', backendDelivery: 'unconfirmed' });
        const task = (async () => {
            try {
                const savedSnapshot = snapshot(merged, origin?.breadcrumbs || current.breadcrumbs);
                const error = thrown instanceof Error ? thrown : new Error(typeof thrown === 'string' ? thrown : 'Non-Error value thrown');
                const event = await constructException(error);
                if (stoppedSending) return { status: 'disposed', backendDelivery: 'unconfirmed' };
                event.event_id = randomUUID().replaceAll('-', '');
                event.timestamp = Date.now() / 1000;
                event.level = context.level === 'fatal' ? 'fatal' : 'error';
                event.environment = environment; event.release = release;
                event.tags = { actor: actorName, customer_tier: tier, operation: merged.operation || 'unknown', error_category: categories.has(merged.errorCategory) ? merged.errorCategory : 'unknown' };
                event.contexts = savedSnapshot.contexts; event.breadcrumbs = savedSnapshot.breadcrumbs;
                if (!(thrown instanceof Error)) event.contexts.operation.thrown_value = scrub.sanitize(thrown);
                if (actorAwareGrouping) event.fingerprint = ['{{ default }}', actorName];
                client.sendEvent(event, { attachments: savedSnapshot.attachments, data: { secretVersion: savedSnapshot.secretVersion } });
                if (object && current.id !== 'run') annotations.set(thrown, { id: current.id, ancestors: current.ancestors, context: scrub.sanitize(merged), breadcrumbs: savedSnapshot.breadcrumbs });
                return { status: 'accepted', eventId: event.event_id, backendDelivery: 'unconfirmed' };
            } catch { return { status: 'failed', backendDelivery: 'unconfirmed' }; }
        })();
        if (object) { const map = records || new Map(); map.set(occurrence, task); if (map.size > 100) map.delete(map.keys().next().value); submissions.set(thrown, map); task.then((result) => { if (result.status !== 'accepted') map.delete(occurrence); }); }
        pending.add(task); task.finally(() => pending.delete(task));
        return task;
    }
    async function bounded(callback) {
        let timer;
        try { return await Promise.race([Promise.resolve().then(callback).catch(() => false), new Promise((resolve) => { timer = setTimeout(() => resolve(false), flushTimeout); })]); }
        finally { clearTimeout(timer); }
    }
    async function flush() {
        if (!client) return { status: 'disabled', backendDelivery: 'unconfirmed' };
        const drained = await bounded(async () => { await Promise.all([...pending]); return client.flush(flushTimeout); });
        return { status: backendFailed ? 'failed' : drained ? 'drained' : 'timeout', backendDelivery: 'unconfirmed' };
    }
    function registerCleanup(callback) { cleanups.add(callback); return () => cleanups.delete(callback); }
    function attachProcessHandlers() {
        if (disposed) throw new Error('Telemetry is disposed');
        if (processOwner?.api === api) return processOwner.detach;
        if (processOwner) throw new Error('Telemetry process handlers already have an owner');
        if (process.listenerCount('uncaughtException') || process.listenerCount('unhandledRejection')) throw new Error('Existing fatal-process handlers require application-owned coordination');
        let terminating = false;
        const terminate = (reason) => (error) => {
            if (terminating) return; terminating = true;
            // A hard deadline preserves failure semantics even if event construction stalls.
            const deadline = setTimeout(() => process.exit(1), flushTimeout);
            void bounded(async () => { await captureException(error, { operation: 'unhandled_exception', failure: { endedRun: true, shutdownReason: reason } }); await flush(); }).finally(() => { clearTimeout(deadline); process.exit(1); });
        };
        const uncaught = terminate('uncaught_exception'); const rejection = terminate('unhandled_rejection');
        const detach = () => { process.off('uncaughtException', uncaught); process.off('unhandledRejection', rejection); if (processOwner?.api === api) processOwner = undefined; cleanups.delete(detach); };
        process.on('uncaughtException', uncaught); process.on('unhandledRejection', rejection);
        processOwner = { api, detach }; cleanups.add(detach); return detach;
    }
    function dispose() {
        if (disposing) return disposing;
        disposed = true;
        for (const cleanup of [...cleanups]) { try { cleanup(); } catch { /* Own listeners only. */ } }
        cleanups.clear();
        disposing = (async () => { const status = await flush(); await bounded(() => client?.close(flushTimeout)); stoppedSending = true; client?.dispose(); logs.length = 0; root.breadcrumbs.length = 0; raw = normalized = undefined; annotations = new WeakMap(); submissions = new WeakMap(); scrub.clear(); local.disable(); return status; })();
        return disposing;
    }
    const api = { enabled: Boolean(client), environment, release, flushTimeout, logger: adaptedLogger, setRawInput, setNormalizedInput, registerSecrets: scrub.registerSecrets, breadcrumb, withOperation, annotate, captureException, flush, dispose, attachProcessHandlers,
        setRawInputUnavailable(reason, { source = 'unavailable', reference } = {}) { raw = undefined; rawStatus = { complete: false, reason, source, reference }; } };
    // Shared with the optional adapter without exporting SDK/client state.
    Object.defineProperty(api, Symbol.for('actor-telemetry.cleanup'), { value: registerCleanup });
    return api;
}
