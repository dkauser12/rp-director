# Changelog

Notable changes to RP Director, in Keep a Changelog style.

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
