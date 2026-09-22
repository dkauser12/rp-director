# RP Director OpenRouter Decisions plugin

Companion server plugin for the local `rp-director-auto` UI extension. It adds:

- `GET /api/plugins/rp-director-openrouter/health`
- `POST /api/plugins/rp-director-openrouter/decide`

The plugin reads the active OpenRouter key from the authenticated SillyTavern user's server-side secrets and forwards only bounded TypeSafe Jev `{ model, state, questions }` requests to `https://openrouter.ai/api/alpha/decisions`.

It never returns or logs the key. Models outside the TypeSafe Jev family, unknown fields, oversized state, unsupported question shapes, and oversized/malformed responses are rejected.

SillyTavern must have `enableServerPlugins: true` and must be restarted after installation.
