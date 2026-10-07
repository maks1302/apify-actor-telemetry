export type ErrorCategory = 'input_validation' | 'authentication' | 'rate_limit' | 'upstream_api' | 'network' | 'parsing' | 'storage' | 'internal' | 'unknown';
export type Level = 'debug' | 'info' | 'warning' | 'error' | 'fatal';
export interface RequestContext { id?: string; url?: string; hostname?: string; httpStatus?: number; elapsedMs?: number; }
export interface RetryAttempt { attempt: number; httpStatus?: number; reason?: string; elapsedMs?: number; }
export interface RetryContext { attempt?: number; limit?: number; history?: RetryAttempt[]; }
export interface FailureContext { endedRun?: boolean; abandonedOperation?: boolean; partialOutput?: boolean; shutdownReason?: string; }
/** Precedence: inherited operation < origin annotation < capture context. Nested request/retry/failure/progress merge in that order. */
export interface EventContext {
    operation?: string;
    errorCategory?: ErrorCategory;
    request?: RequestContext;
    retry?: RetryContext;
    failure?: FailureContext;
    progress?: Record<string, number>;
    diagnostic?: unknown;
    /** Same object within an operation deduplicates. New operations are new occurrences; use an explicit ID to distinguish root occurrences. */
    occurrenceId?: string;
    level?: 'error' | 'fatal';
}
export interface Logger {
    debug(message: string, data?: unknown): void;
    info(message: string, data?: unknown): void;
    warning(message: string, data?: unknown): void;
    error(message: string, data?: unknown): void;
    exception?(error: Error, message: string, data?: unknown): void;
    getOptions?(): { logger?: { on(event: 'line', callback: (line: string) => void): unknown; off(event: 'line', callback: (line: string) => void): unknown } };
}
export interface CaptureResult { status: 'accepted' | 'duplicate' | 'failed' | 'disabled' | 'disposed'; eventId?: string; backendDelivery: 'unconfirmed'; }
export interface FlushResult { status: 'drained' | 'timeout' | 'failed' | 'disabled'; backendDelivery: 'unconfirmed'; }
export interface InputSource { source?: string; reference?: string; }
/** A test seam: envelope is intentionally opaque to Actor business logic. */
export type TransportFactory = (options: unknown) => { send(envelope: unknown): PromiseLike<{ statusCode?: number }>; flush(timeout: number): PromiseLike<boolean> };
export interface TelemetryOptions<L extends Logger = Logger> {
    actorName: string;
    actorVersion?: string;
    inputSchema?: { properties?: Record<string, unknown>; [key: string]: unknown };
    logger?: L;
    env?: Record<string, string | undefined>;
    transport?: TransportFactory;
    budgets?: { inputBytes?: number; attachmentBytes?: number; eventBytes?: number; logLineBytes?: number; logBytes?: number };
    /** Verified means the caller has confirmed attachment support for this destination/version. No hostname inference. */
    capabilities?: { attachments?: { enabled: boolean; verified: boolean } };
    actorAwareGrouping?: boolean;
}
export interface ActorTelemetry<L extends Logger = Logger> {
    readonly enabled: boolean;
    readonly environment: 'production' | 'development' | 'test';
    readonly release: string;
    readonly flushTimeout: number;
    readonly logger: L | undefined;
    setRawInput(value: unknown, source?: InputSource): void;
    setNormalizedInput(value: unknown): void;
    setRawInputUnavailable(reason: string, source?: InputSource): void;
    registerSecrets(values: unknown): void;
    breadcrumb(message: string, data?: unknown, level?: Level): void;
    withOperation<T>(context: EventContext, callback: () => T): T;
    annotate<T>(error: T, context: EventContext): T;
    captureException(error: unknown, context?: EventContext): Promise<CaptureResult>;
    flush(): Promise<FlushResult>;
    dispose(): Promise<FlushResult>;
    /** Opt-in exclusive process ownership; rejects conflicting fatal handlers. Detach/dispose removes only owned listeners. */
    attachProcessHandlers(): () => void;
}
export declare function createActorTelemetry<L extends Logger = Logger>(options: TelemetryOptions<L>): ActorTelemetry<L>;
