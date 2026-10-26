// Response bodies have a separate budget: preserve useful text instead of the
// generic diagnostic string marker. This helper never reads an HTTP stream.
export function createResponseCapture(scrub, limit) {
    let versions = new WeakMap();
    const bytes = (value) => Buffer.byteLength(JSON.stringify(value));

    function preview(value) {
        const text = typeof value === 'string' ? value : JSON.stringify(value);
        let low = 0;
        let high = text.length;
        while (low < high) {
            const middle = Math.ceil((low + high) / 2);
            if (bytes(text.slice(0, middle) + '[TRUNCATED]') <= limit) low = middle;
            else high = middle - 1;
        }
        return text.slice(0, low).replace(/[\uD800-\uDBFF]$/, '') + '[TRUNCATED]';
    }

    function snapshot(response) {
        if (response === undefined) return undefined;
        const result = {};
        try {
            if (Number.isInteger(response.httpStatus) && response.httpStatus >= 100 && response.httpStatus <= 599) result.httpStatus = response.httpStatus;
            const previous = versions.get(response);
            // A prefix can contain only part of a newly registered secret. It is
            // no longer safe to send, even after ordinary text redaction.
            if (response.completeness?.truncated && previous !== undefined && previous !== scrub.secretVersion) {
                result.completeness = { complete: false, reason: 'secret_registered_after_truncation', limit_bytes: limit };
            } else if (response.body === undefined) {
                result.completeness = { complete: false, reason: 'response_body_unavailable', limit_bytes: limit };
                if (response.completeness?.reason) result.completeness.reason = scrub.sanitizeText(response.completeness.reason).slice(0, 128);
            } else {
                let omitted = false;
                const body = scrub.sanitize(response.body, { complete: true, onOmission: () => { omitted = true; } });
                const size = bytes(body);
                if (size > limit) {
                    result.body = preview(body);
                    result.completeness = { complete: false, truncated: true, reason: 'response_exceeds_budget', format: typeof body === 'string' ? 'text' : 'json', sanitized_bytes: size, limit_bytes: limit };
                } else {
                    result.body = body;
                    result.completeness = response.completeness?.complete === false
                        ? { ...scrub.sanitize(response.completeness), limit_bytes: limit }
                        : { complete: !omitted, ...(omitted ? { reason: 'response_not_json_serializable' } : {}), sanitized_bytes: size, limit_bytes: limit };
                }
            }
        } catch {
            result.completeness = { complete: false, reason: 'response_body_unavailable', limit_bytes: limit };
        }
        versions.set(result, scrub.secretVersion);
        return result;
    }

    function omit(response) {
        if (!response) return undefined;
        return { httpStatus: response.httpStatus, completeness: { complete: false, reason: 'event_budget_exceeded', limit_bytes: limit } };
    }

    return { snapshot, omit, clear() { versions = new WeakMap(); } };
}
