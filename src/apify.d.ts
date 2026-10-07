import type { ActorTelemetry, EventContext } from './index.js';
interface LifecycleEvents {
    on(event: 'aborting' | 'migrating' | 'exit', callback: (...args: any[]) => any): unknown;
    off(event: 'aborting' | 'migrating' | 'exit', callback: (...args: any[]) => any): unknown;
}
export interface ActorLifecycle extends LifecycleEvents {
    initialized?: boolean;
    getDefaultInstance?(): { initialized?: boolean };
    config?: { getEventManager(): LifecycleEvents };
}
/** Attach after successful Actor.init(); cleanup retains the original event manager. */
export declare function attachActorLifecycle(actor: ActorLifecycle, telemetry: ActorTelemetry): () => void;
export declare function loadActorInput<T = unknown>(actor: { getValue(key: string): Promise<unknown>; getInput(): Promise<T> }, telemetry: ActorTelemetry, options?: { inputKey?: string; reference?: string; env?: Record<string, string | undefined> }): Promise<T>;
/** Actor.main owns initialization/exit. Lifecycle attachment occurs inside its initialized callback. Captures before its internal catch; rethrows unchanged. */
export declare function runActorMain<T>(actor: ActorLifecycle & { main(callback: () => Promise<T>, options?: any): Promise<unknown> }, telemetry: ActorTelemetry, callback: () => Promise<T>, options?: any): Promise<unknown>;
/** Caller owns init and cleanup. Default failure exitCode is 1; explicit exitOptions are forwarded unchanged. */
export declare function exitActor(actor: { exit(options?: any): Promise<unknown> }, telemetry: ActorTelemetry, options?: { error?: unknown; reason?: string; exitOptions?: any; context?: EventContext }): Promise<unknown>;
