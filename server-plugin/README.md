# RP Director OpenRouter Decisions plugin

Companion server plugin for the RP Director extension. It adds:

- `GET /api/plugins/rp-director-openrouter/health`
- `POST /api/plugins/rp-director-openrouter/decide`

The plugin reads the active OpenRouter key from the authenticated SillyTavern user's server-side secrets and forwards only bounded TypeSafe Jev `{ model, state, questions }` requests to `https://openrouter.ai/api/alpha/decisions`.

It never returns or logs the key. Models outside the TypeSafe Jev family, unknown fields, oversized state, unsupported question shapes, and oversized/malformed responses are rejected.

SillyTavern must have `enableServerPlugins: true` and must be restarted after installation.

## Usage reporting

The proxy preserves OpenRouter's `usage` object, including `cost` in USD and `input_tokens` / `output_tokens`, as described in the [Decisions API reference](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request). RP Director displays the reported amounts per request, per turn, and for the current browser session. Missing usage remains unknown; it is never estimated from token counts. Installing this plugin update is a separate host administration step.
