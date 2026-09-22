# RP Director

The consolidated base extension includes the compact UI and automatic workflow developed in the Auto test build. Existing base settings, outcome tables, personal presets and accepted checkpoints remain authoritative.

A streamlined SillyTavern extension that replaces prompt-side dice adjudication with a staged Director pipeline:

1. A pre-generation batch chooses the next speaker and adjudicates the first qualifying user attempt.
2. If the writer newly plans an uncertain consequential NPC action, it may call one non-stealth `RPDirector_AdjudicateTurn` tool before prose. The tool validates at most three bounded actions and returns attempt-scoped frozen permits.
3. A separate post-generation observer records only factual changes established by the selected final prose. The ruling or permit itself is never treated as proof.

## Install

RP Director requires a current SillyTavern installation.

1. Open **Extensions** in SillyTavern.
2. Choose **Install extension**.
3. Paste `https://github.com/dkauser12/rp-director`.
4. Reload SillyTavern, open **RP Director**, choose a connection, and run its connection test before enabling it for a chat.

For **OpenRouter Jev Decisions**, also install the companion plugin described below and restart SillyTavern.

Code maps judge outputs through the editable outcome table, freezes the ruling before prose, and forces the selected group member to write the reply. Wording swipes reuse the ruling and any permit without another tool or decision call; explicit rerolls create linked rulings.

## Normal use

1. Type a message in SillyTavern.
2. Use SillyTavern's normal **Send**, **Enter**, or **Ctrl+Enter** (when Enter-to-send is enabled).
3. Read the reply. Continuing from that selected reply implicitly commits its validated observer changes. Swipe first if you want different wording.

The strip shows status and **⋯** only. Empty-composer continuation and slash commands retain their native behavior. When a new swipe can reuse or change existing rulings, ST shows a choice before the writer request. Merely selecting a saved swipe does not open that dialog. Cancel/Escape aborts the pending generation. **New scene & continue** commits the selected reply, starts a new scene and runs Director. **Repair selected branch** retries its observer at the correct predecessor; it never copies nonempty later state backwards.

## What counts as a check

An action is adjudicated only when it attempts to change fictional state, can genuinely fail, and failure would matter. Ordinary dialogue, feelings, wants, choices, trivial activity, and results already settled by the scene do not receive checks.

The automatic judge recognizes seven broad families: overcome/operate, contest/impose, evade/resist, conceal/deceive, detect/discover, influence/negotiate, and acquire/secure. These labels guide the writer and inspector; the one binding proposition remains whether the first primary intended state change succeeds now.

If a message bundles multiple consequential attempts, only the first is resolved. The writer must leave later attempts pending.

## Newly planned NPC actions

On writer APIs with ST function calling enabled, the extension exposes the plan-only `RPDirector_AdjudicateTurn` tool during the initial Director generation. The writer may use its normal reasoning first, then submits the bounded action proposal before any prose. No thinking trace is requested or parsed as tool arguments.

The tool decides the proposed actions and opens ST's native popup with the results. **Keep & continue** returns the final permit to ST, which then runs the writer continuation. **Reroll** draws again from the same assessment and table in dice mode; **Reassess** makes a new judge call in threshold mode, where no random draw exists. Each new result is shown again. **Cancel generation**, Escape, Stop, and changed chat identity prevent that permit from reaching the continuation. Discarded roll history stays local; only kept values enter the tool response.

The writer cannot change the speaker, cite evidence outside the frozen snapshot, author feelings/consent/trust/permanent attitude, submit draft prose, or call the tool twice. Tool instructions explain when to call, when to skip, which arguments to send, and how to use the returned permit. Selecting a different saved swipe restores its own rulings, even if another swipe was rerolled later.

If the selected writer backend does not support tools, the injected boundary tells it to leave newly invented consequential NPC actions unresolved. There is no draft → tool → rewrite pass.

## Observation and acceptance

Every completed Director reply is observed after generation. The observer has its own connection selection: choose a chat-capable SillyTavern connection profile for strict structured observation, or leave it on **Jev bounded observer** to ask only ruling-entailment questions. Mock/Rules use deterministic local QA behavior. Allowed factual operations are limited to registered time, location, item, condition, knowledge, and secret-reveal updates.

Observation results stay provisional. They commit once when the user sends the next message or chooses **Commit reply**. Swiping, regenerating, deleting, editing, or switching variants does not implicitly accept the old wording. If observation fails, prose and prior state are preserved. The strip says **Needs repair**, with the reason in its tooltip. Native Send retries a failed selected observation automatically; initial empty-baseline failures can also recover on load. Nonempty unknown history requires an explicit reset or a known saved swipe.

## Coexistence

Use **RP Director**. The legacy **RP Director Auto** test copy yields while the base extension is enabled. The base disables a loaded Auto runtime before registering its tool and native controls. Existing Auto-only chat history can migrate as a whole, including saved swipe markers; if a base history already exists, it takes precedence. Legacy pending replies are made retryable for observation without changing accepted history.

## Where Jev calls appear

The pre-pass and bounded observer are background decision requests, shown in **Inspector & recovery**, not chat tool messages. The writer-facing function is named **RPDirector_AdjudicateTurn**. A visible ST tool message appears only if the writer invokes it for a newly planned consequential NPC action. Ordinary dialogue and wording swipes reusing saved rulings do not require a fresh tool call. The inspector distinguishes background network calls, tool review and preserved rulings.

## Connections

- **Jev:** TypeSafe's native endpoint and a session-only key.
- **OpenRouter Jev Decisions:** the companion server plugin at `plugins/rp-director-openrouter` calls OpenRouter's `/api/alpha/decisions` endpoint with the OpenRouter key already saved in SillyTavern. It never exposes that key to the UI extension.
- **Structured judge:** an OpenAI-compatible endpoint, preferably through a SillyTavern connection profile so the extension never sees its key.
- **Mock:** deterministic local QA only.

Invalid, missing, refused, truncated, or malformed decisions pause before generation; nothing is silently guessed.

### Companion plugin installation

The repository includes the companion source under `server-plugin/`. Install that directory as `SillyTavern/plugins/rp-director-openrouter`. SillyTavern must have `enableServerPlugins: true` and be restarted after installing the plugin. Director reports an actionable HTTP 404 error if the UI extension is present but the companion plugin is not loaded.

The plugin accepts only bounded TypeSafe Jev decision batches, uses the authenticated user's active server-side OpenRouter key, applies request/response size limits and a timeout, and forwards no writer prompt or credential back to the browser.

## Local-only presets

Optional personal presets are loaded from `profiles/local/presets.json`. That directory is gitignored, fetched only at runtime, and never compiled into `index.js`. Copy `profiles/local.example.json` as a starting point. Loading a preset fills the table editor; **Apply table** remains the explicit activation step.

Character cards, chats, local presets, saved keys, and SillyTavern settings do not belong in this repository. Keep personal presets under the gitignored `profiles/local/` directory. API keys are either session-only or remain in SillyTavern's server-side secret store, depending on the selected connection.

## Build and verify

```text
npm install
npm run verify
```

The built `index.js` is included because SillyTavern loads it directly. Source lives in `src/`; unit tests live in `tests/unit/`.
