import { readSecret, SECRET_KEYS } from '../../src/endpoints/secrets.js';
import { createDecisionForwarder, sendProxyError } from './core.mjs';

export const info = {
    id: 'rp-director-openrouter',
    name: 'RP Director OpenRouter Decisions',
    description: 'Authenticated, bounded proxy from RP Director Auto to OpenRouter Decisions using SillyTavern’s saved OpenRouter key.',
};

export async function init(router) {
    router.get('/health', (_request, response) => {
        response.json({ ok: true, plugin: info.id, version: '0.1.0' });
    });

    router.post('/decide', async (request, response) => {
        const forward = createDecisionForwarder({
            getApiKey: () => readSecret(request.user.directories, SECRET_KEYS.OPENROUTER),
        });
        try {
            const result = await forward(request.body, request.signal);
            response.status(result.status).json(result.body);
        } catch (error) {
            sendProxyError(response, error);
        }
    });

    console.log('[rp-director-openrouter] Decisions proxy ready at /api/plugins/rp-director-openrouter/decide');
}

export async function exit() {
    return Promise.resolve();
}
