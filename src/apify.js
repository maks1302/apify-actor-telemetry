// Lifecycle ownership remains with the injected Actor. These helpers never install process handlers.
const attached = new WeakMap();
async function bounded(telemetry, callback) {
    let timer;
    try { return await Promise.race([Promise.resolve().then(callback).catch(() => undefined), new Promise((resolve) => { timer = setTimeout(resolve, telemetry.flushTimeout); })]); }
    finally { clearTimeout(timer); }
}
export function attachActorLifecycle(actor, telemetry) {
    let instances = attached.get(actor);
    if (!instances) { instances = new Map(); attached.set(actor, instances); }
    if (instances.has(telemetry)) return instances.get(telemetry);
    if (typeof actor.on !== 'function' || typeof actor.off !== 'function') throw new TypeError('Actor.on/off are required');
    const handlers = ['aborting', 'migrating', 'exit'].map((reason) => {
        const callback = () => { telemetry.breadcrumb('Actor lifecycle', { shutdownReason: reason }); return telemetry.flush(); };
        actor.on(reason, callback); return [reason, callback];
    });
    let unregister;
    const detach = () => { for (const [reason, callback] of handlers) actor.off(reason, callback); instances.delete(telemetry); unregister?.(); };
    instances.set(telemetry, detach);
    unregister = telemetry[Symbol.for('actor-telemetry.cleanup')](detach);
    return detach;
}
export async function loadActorInput(actor, telemetry, { env = process.env, inputKey = env.ACTOR_INPUT_KEY || env.APIFY_INPUT_KEY || 'INPUT', reference } = {}) {
    // getValue reads stored JSON before getInput applies SDK decryption/defaults.
    // The current Actor key and historical SDK fallback can also be injected for tests.
    try {
        const original = await actor.getValue(inputKey);
        if (original === null || original === undefined) telemetry.setRawInputUnavailable('stored_input_missing', { source: 'Actor.getValue_before_getInput', reference });
        else telemetry.setRawInput(original, { source: 'Actor.getValue_before_sdk_decryption_and_defaults', reference });
    } catch {
        telemetry.setRawInputUnavailable('stored_input_loading_or_parsing_failed', { source: 'Actor.getValue_before_getInput', reference });
    }
    try {
        const effective = await actor.getInput();
        telemetry.setNormalizedInput(effective);
        return effective;
    } catch (error) {
        telemetry.annotate(error, { operation: 'load_input', errorCategory: 'input_validation' });
        throw error;
    }
}
export async function runActorMain(actor, telemetry, callback, options) {
    const detach = attachActorLifecycle(actor, telemetry);
    let callbackStarted = false;
    let handledFailure = false;
    let callbackFailure;
    try {
        return await actor.main(async () => {
            callbackStarted = true;
            let result;
            try { result = await callback(); }
            catch (error) {
                handledFailure = true; callbackFailure = error;
                await bounded(telemetry, async () => { await telemetry.captureException(error, { failure: { endedRun: true, shutdownReason: 'application_failure' } }); await telemetry.flush(); });
                throw error;
            }
            await telemetry.flush();
            return result;
        }, options);
    } catch (error) {
        if (!handledFailure || error !== callbackFailure) await bounded(telemetry, async () => { await telemetry.captureException(error, { operation: callbackStarted ? 'exit_actor' : 'initialize_actor', failure: { endedRun: true, shutdownReason: 'application_failure' } }); await telemetry.flush(); });
        throw error;
    } finally { detach(); }
}
// For explicit init/exit workflows: caller owns init, persistence and cleanup; this owns only delivery before exit.
// An application failure is captured even when the caller deliberately supplies exitCode: 0.
export async function exitActor(actor, telemetry, options = {}) {
    const errorSupplied = Object.hasOwn(options, 'error');
    const { error, reason = errorSupplied ? 'application_failure' : 'normal_completion', exitOptions, context = {} } = options;
    await bounded(telemetry, async () => {
        if (errorSupplied) await telemetry.captureException(error, { ...context, failure: { ...context.failure, endedRun: true, shutdownReason: reason } });
        await telemetry.flush();
    });
    return actor.exit(exitOptions ?? { exitCode: errorSupplied ? 1 : 0 });
}
