# Changelog

Notable changes to RP Director, in Keep a Changelog style.

## [0.8.0] - 2026-09-29

A streamlined release: a simpler workflow and interface, plus four new modules. Settings and chats from 0.7 are migrated automatically; see "Upgrading from 0.7" in the README.

### Changed
- Send is never blocked by the Director. The judge gets a wait budget (Settings, default 10 seconds). Anything still undecided when the budget runs out is left unruled, and the reply goes on.
- A failure leaves only the affected part of the turn unruled. You get one notice per kind of failure, and the reply's badge offers **Try the judge again**.
- Swiping a reply that has a ruling asks first: **Keep the result**, **Roll again** or **Cancel**. The question can be switched off. Swipes of replies without a ruling reuse that turn's other decisions silently.
- A ruling belongs to the user message it rules on. Edits, deletions, Stop and swipes elsewhere in the chat no longer lose it or roll it again.
- New interface:
  - A small drawer with status, Enabled, **Pause for this chat** and **Open Director**.
  - A workspace with the tabs This chat, Activity, Outcomes, Lore and Settings. It opens from the drawer, the wand menu, `/director` and reply badges.
  - Results appear as badges on replies, stored per swipe and never in the message text.
- The NPC-action review shows odds as a percentage and the roll from 0 to 100, with **Keep & continue**, **Roll again** and **Cancel**. The review can be switched off.
- Chat records are stored compactly and grow by about 3 KB per turn.
- Plain language throughout the interface, which shows the player as {{user}}.

### Added
- **Pacing:** the judge names the scene type (combat, conversation, travel, intimate or downtime), and the writer gets editable guidance that keeps beats short and never skips time.
- **Hand-back beats** (optional): the reply stops at the first beat where {{user}} must act. With the Dynamic Response extension enabled, the reply also carries its cue tag.
- **Reply check:** one request after each reply. A reply that writes for {{user}} or breaks the ruling gets one automatic corrected swipe per user turn, and the original stays among the swipes. A reply that ignores {{user}} or repeats itself gets a nudge on the next turn.
- **Preset macros** through SillyTavern's macro engine: `{{director::outcome}}`, `odds`, `roll`, `scene`, `pack`, `meter::<character>::<meter>`, `active` and `module::<name>`.
- **Slash commands:** `/director`, `/director-pause`, `/director-reroll`, `/director-reassess`, `/director-pack`, `/director-speaker` and `/director-get`.
- **Request costs:** OpenRouter's reported cost and tokens for each Director request in Activity, per turn in the badge popup and per session in Settings. The companion server plugin now passes usage through.

### Removed
- The post-reply observer and its state machine, with the Observer connection. Reply check replaces what it showed. Tracked facts went with it.
- The legacy pipeline, the first-run binding confirmation, the play strip above the composer, and Mock in the connection menu. Settings move to the staged pipeline.
- The text footer under replies. Opening an older chat removes its footers once.

### Fixed
- A Send is never swallowed by the Director's own bookkeeping.
- Director records no longer bloat chat files.
- Director instructions no longer forbid a preset's own fictional tracker block, and no longer invite a preset's dice back in.

## [0.7.1] - 2026-09-27

### Fixed
- Label the player as `{{user}}` throughout the interface. The judge and writer still receive the persona name used in the transcript.

### Added
- This changelog.

## [0.7.0] - 2026-09-26

### Added
- Judge-selected lore, with per-book modes and support for TunnelVision indexes.
- Saved lore picks that follow swipes, plus a view of lore used in the last reply.

### Fixed
- Keep public and private lore separate for discovery rulings, and preserve keyword lore when selection fails.

## [0.6.x] - 2026-09-24

### Added
- A staged pipeline that selects the exact move, identifies its actor and target, and judges it using permitted evidence.
- Frozen NPC reactions and hand-offs, plus a result footer.
- Genre packs, judge-assessed character meters, and secrets with tracked knowledge.

### Changed
- Use the staged pipeline by default. Meters move at most one level per turn after their first assessment.

### Fixed
- Save the Threshold / Dice choice immediately and preserve it when loading a preset.

## [0.5.x] - 2026-09-20

### Added
- Actor-aware decisions, editable outcome tables, and the NPC-action writer tool.
- Native Send and swipe integration, with frozen rulings reused for wording changes.

### Changed
- Consolidate the automatic workflow and its controls in the base extension.
