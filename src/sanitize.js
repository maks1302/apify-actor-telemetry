// Extracted and hardened from google-map-scrapper-apify/src/monitoring/index.js.
const SECRET_KEY = /password|passwd|secret|token|authorization|cookie|api[_-]?key|access[_-]?key|signature|credential|private[_-]?key|sentry[_-]?dsn/i;
const REDACTED = '[REDACTED]';



export function createSanitizer(env = {}, schema = {}) {
    const secrets = new Set(Object.entries(env).filter(([key, value]) => SECRET_KEY.test(key) && value).map(([, value]) => String(value)));
    const secretFields = new Set();
    function sanitizeText(value, urlDepth = 0) {
        let text = String(value);
        for (const secret of secrets) {
            // Also censor already-truncated SDK/log fields containing a long secret.
            if (secret.length > 32 && !text.includes(secret) && text.includes(secret.slice(0, 16))) return REDACTED;
            text = text.split(secret).join(REDACTED);
            text = text.split(encodeURIComponent(secret)).join(REDACTED);
        }
        return text
            .replace(/apify_api_[\w-]+/g, REDACTED)
            .replace(/-----BEGIN [\s\S]*?PRIVATE KEY-----[\s\S]*?-----END [\s\S]*?PRIVATE KEY-----/g, REDACTED)
            .replace(/ENCRYPTED_(?:JSON|VALUE):[^\s"']+/g, REDACTED)
            .replace(/\b(?:https?|socks5?):\/\/[^\s"'<>]+/gi, (match) => {
                try {
                    const url = new URL(match);
                    let changed = false;
                    if (url.username || url.password) { url.username = ''; url.password = ''; changed = true; }
                    for (const key of [...url.searchParams.keys()]) if (SECRET_KEY.test(key) || /^x-amz-|^x-goog-|^sig$|^key$|^auth$/i.test(key)) { url.searchParams.set(key, REDACTED); changed = true; }
                    for (const key of [...url.searchParams.keys()]) {
                        const value = url.searchParams.get(key);
                        if (/https?:\/\//i.test(value)) {
                            const clean = urlDepth < 5 ? sanitizeText(value, urlDepth + 1) : REDACTED;
                            if (clean !== value) { url.searchParams.set(key, clean); changed = true; }
                        }
                    }
                    if (SECRET_KEY.test(url.hash)) { url.hash = ''; changed = true; }
                    return changed ? url.toString() : match;
                } catch { return '[INVALID_URL]'; }
            })
            .replace(/\b(?:Bearer|Basic)\s+[^\s,;"']+/gi, REDACTED)
            .replace(/(["']?(?:password|token|secret|authorization|cookie|api[_-]?key|access[_-]?key|signature|credential)["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&"'<>]+)/gi, `$1${REDACTED}`)
            .replace(/(\b(?:cookie|set-cookie|authorization)\s*:\s*)[^\r\n]+/gi, `$1${REDACTED}`);
    }

    function sanitize(value, { complete = false, onOmission } = {}) {
        const seen = new WeakSet();
        let nodes = 0;
        function visit(item, depth = 0, definition = complete ? schema : {}, path = []) {
            if (!complete && (++nodes > 2000 || depth > 15)) return '[TRUNCATED: diagnostic structure limit]';
            if (typeof item === 'string') {
                const text = sanitizeText(item);
                return !complete && text.length > 4096 ? '[TRUNCATED: diagnostic string limit]' : text;
            }
            if (item === null || typeof item === 'boolean' || typeof item === 'number') return item;
            if (typeof item !== 'object') return item === undefined ? undefined : sanitizeText(item);
            if (seen.has(item)) { onOmission?.(); return '[CIRCULAR]'; }
            seen.add(item);
            let output;
            if (Array.isArray(item)) {
                const values = complete ? item : item.slice(0, 100);
                output = values.map((entry) => visit(entry, depth + 1, definition.items || {}, [...path, '*']));
                if (values.length < item.length) output.push('[TRUNCATED: array limit]');
            } else {
                output = {};
                const entries = Object.entries(item);
                for (const [key, entry] of complete ? entries : entries.slice(0, 100)) {
                    const field = definition.properties?.[key] || {};
                    const nextPath = [...path, key];
                    Object.defineProperty(output, sanitizeText(key), { value: SECRET_KEY.test(key) || field.isSecret === true || secretFields.has(JSON.stringify(nextPath)) ? REDACTED : visit(entry, depth + 1, field, nextPath), enumerable: true, configurable: true, writable: true });
                }
                if (!complete && entries.length > 100) output._monitoring_truncation = 'object property limit';
            }
            seen.delete(item);
            return output;
        }
        try { return visit(value); } catch { onOmission?.(); return '[UNAVAILABLE: diagnostic serialization failed]'; }
    }

    function rememberInputSecrets(value) {
        const seen = new WeakSet();
        function walk(item, definition = schema, path = []) {
            if (!item || typeof item !== 'object' || seen.has(item)) return;
            seen.add(item);
            for (const [key, entry] of Object.entries(item)) {
                const nextPath = [...path, Array.isArray(item) ? '*' : key];
                const field = Array.isArray(item) ? definition.items || {} : definition.properties?.[key] || {};
                if (typeof entry === 'string' && /^ENCRYPTED_(VALUE|JSON):/.test(entry)) secretFields.add(JSON.stringify(nextPath));
                if (SECRET_KEY.test(key) || field.isSecret === true || secretFields.has(JSON.stringify(nextPath))) {
                    const collected = new WeakSet();
                    const collect = (v) => {
                        if (typeof v === 'string' && v) secrets.add(v);
                        else if (v && typeof v === 'object' && !collected.has(v)) { collected.add(v); Object.values(v).forEach(collect); }
                    };
                    collect(entry);
                } else walk(entry, field, nextPath);
            }
        }
        try { walk(value); } catch { /* Reporting must remain best effort. */ }
    }


    function registerSecrets(value) {
        const seen = new WeakSet();
        function collect(item) {
            if (typeof item === 'string' && item) secrets.add(item);
            else if (item && typeof item === 'object' && !seen.has(item)) {
                seen.add(item); Object.values(item).forEach(collect);
            }
        }
        try { collect(value); } catch { /* Best effort. */ }
    }
    return { sanitize, sanitizeText, registerSecrets, rememberInputSecrets, get secretVersion() { return secrets.size; }, clear() { secrets.clear(); secretFields.clear(); } };
}
