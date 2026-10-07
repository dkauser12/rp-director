const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_QUESTIONS = 16;
const QUESTION_TYPES = new Set(['choice', 'score', 'noul']);

export class DecisionProxyError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = 'DecisionProxyError';
        this.status = status;
        this.code = code;
    }
}

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function serializedBytes(value) {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function validateQuestion(id, question) {
    if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(id)) throw new DecisionProxyError(400, 'invalid_question_id', `Invalid question id ${JSON.stringify(id)}.`);
    if (!isObject(question) || !QUESTION_TYPES.has(question.type)) throw new DecisionProxyError(400, 'invalid_question', `Question ${id} has an unsupported type.`);
    if (typeof question.instructions !== 'string' || !question.instructions.trim() || question.instructions.length > 4000) throw new DecisionProxyError(400, 'invalid_question', `Question ${id} needs bounded instructions.`);
    if (question.type === 'choice') {
        if (!isObject(question.criteria)) throw new DecisionProxyError(400, 'invalid_question', `Choice question ${id} needs a criteria object.`);
        const options = Object.keys(question.criteria);
        if (options.length < 2 || options.length > 255) throw new DecisionProxyError(400, 'invalid_question', `Choice question ${id} needs 2–255 options.`);
    }
    if (question.type === 'score') {
        if (!Array.isArray(question.criteria) || question.criteria.length < 2 || question.criteria.length > 16 || question.criteria.some(value => typeof value !== 'string')) throw new DecisionProxyError(400, 'invalid_question', `Score question ${id} needs 2–16 string criteria.`);
    }
    if (question.type === 'noul' && question.criteria !== undefined) {
        if (!isObject(question.criteria) || typeof question.criteria.true !== 'string' || typeof question.criteria.false !== 'string') throw new DecisionProxyError(400, 'invalid_question', `Noul question ${id} has invalid criteria.`);
    }
}

export function validateDecisionRequest(raw) {
    if (!isObject(raw)) throw new DecisionProxyError(400, 'invalid_request', 'Request body must be an object.');
    const allowed = new Set(['requestId', 'model', 'state', 'questions']);
    const unknown = Object.keys(raw).find(key => !allowed.has(key));
    if (unknown) throw new DecisionProxyError(400, 'invalid_request', `Unknown request field ${unknown}.`);
    const requestId = typeof raw.requestId === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(raw.requestId) ? raw.requestId : null;
    if (!requestId) throw new DecisionProxyError(400, 'invalid_request_id', 'requestId must be a bounded identifier.');
    const model = typeof raw.model === 'string' ? raw.model.trim() : '';
    if (!/^(?:~)?typesafe\/jev(?:-|$)/.test(model) || model.length > 120) throw new DecisionProxyError(400, 'invalid_model', 'Only TypeSafe Jev decision models are allowed.');
    if (!isObject(raw.questions)) throw new DecisionProxyError(400, 'invalid_questions', 'questions must be an object.');
    const entries = Object.entries(raw.questions);
    if (entries.length < 1 || entries.length > MAX_QUESTIONS) throw new DecisionProxyError(400, 'invalid_questions', `A request needs 1–${MAX_QUESTIONS} questions.`);
    for (const [id, question] of entries) validateQuestion(id, question);
    if (raw.state === undefined || serializedBytes(raw.state) > 96 * 1024) throw new DecisionProxyError(400, 'invalid_state', 'state is missing or exceeds 96 KiB.');
    const upstream = { model, state: raw.state, questions: raw.questions };
    if (serializedBytes(upstream) > MAX_REQUEST_BYTES) throw new DecisionProxyError(413, 'request_too_large', 'Decision request exceeds 128 KiB.');
    return { requestId, upstream };
}

async function readLimited(response, maxBytes = MAX_RESPONSE_BYTES) {
    const declared = Number(response.headers.get('content-length') || 0);
    if (Number.isFinite(declared) && declared > maxBytes) throw new DecisionProxyError(502, 'response_too_large', 'OpenRouter response exceeded 256 KiB.');
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new DecisionProxyError(502, 'response_too_large', 'OpenRouter response exceeded 256 KiB.');
    return text;
}

function safeUpstreamError(status, parsed) {
    const message = typeof parsed?.error?.message === 'string' ? parsed.error.message.slice(0, 600) : `OpenRouter Decisions returned HTTP ${status}.`;
    const code = typeof parsed?.error?.code === 'string' || typeof parsed?.error?.code === 'number' ? String(parsed.error.code) : 'upstream_http';
    return { error: { code, message } };
}

export function createDecisionForwarder({ getApiKey, fetchImpl = fetch, endpoint = 'https://openrouter.ai/api/alpha/decisions', timeoutMs = 30000 } = {}) {
    if (typeof getApiKey !== 'function') throw new Error('getApiKey is required');
    return async function forwardDecision(raw, callerSignal) {
        const { requestId, upstream } = validateDecisionRequest(raw);
        const apiKey = String(await getApiKey() || '');
        if (!apiKey) throw new DecisionProxyError(503, 'missing_openrouter_key', 'No active OpenRouter key is saved in SillyTavern.');
        const signals = [AbortSignal.timeout(timeoutMs)];
        if (callerSignal) signals.push(callerSignal);
        const signal = AbortSignal.any(signals);
        let response;
        try {
            response = await fetchImpl(endpoint, {
                method: 'POST',
                headers: {
                    authorization: `Bearer ${apiKey}`,
                    'content-type': 'application/json',
                    'HTTP-Referer': 'https://sillytavern.app',
                    'X-Title': 'RP Director Auto',
                },
                body: JSON.stringify(upstream),
                signal,
            });
        } catch (error) {
            if (signal.aborted) throw new DecisionProxyError(504, 'upstream_timeout', 'OpenRouter Decisions request timed out or was cancelled.');
            throw new DecisionProxyError(502, 'upstream_network', `OpenRouter Decisions request failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        const text = await readLimited(response);
        let parsed;
        try { parsed = text ? JSON.parse(text) : {}; } catch { throw new DecisionProxyError(502, 'malformed_upstream', 'OpenRouter Decisions returned invalid JSON.'); }
        if (!response.ok) return { status: response.status, body: { requestId, ...safeUpstreamError(response.status, parsed) } };
        if (!isObject(parsed.answers)) throw new DecisionProxyError(502, 'malformed_upstream', 'OpenRouter Decisions returned no answers object.');
        return {
            status: 200,
            body: {
                requestId,
                model: typeof parsed.model === 'string' ? parsed.model : null,
                answers: parsed.answers,
                // Keep OpenRouter's cost and token counts intact; absent usage stays unknown.
                usage: isObject(parsed.usage) ? parsed.usage : null,
                provider: typeof parsed.provider === 'string' ? parsed.provider : null,
                id: typeof parsed.id === 'string' ? parsed.id : null,
            },
        };
    };
}

export function sendProxyError(response, error) {
    const status = error instanceof DecisionProxyError ? error.status : 500;
    const code = error instanceof DecisionProxyError ? error.code : 'internal_error';
    const message = error instanceof DecisionProxyError ? error.message : 'RP Director Decisions proxy failed.';
    response.status(status).json({ error: { code, message } });
}
