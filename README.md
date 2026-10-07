# RP Director

A SillyTavern extension that makes a separate decision model, TypeSafe's **Jev**, the referee of your roleplay. It decides what the writer model shouldn't decide for itself:
- whether an attempt succeeds
- who speaks next
- how each character feels about you
- who knows which secret

These decisions are frozen before the writer runs, and the writer is told to follow them.

The writer never grades its own homework. Jev only picks from options, gives scores or gives probabilities. Code turns those answers into rulings, and dice (if you use them) add real uncertainty.

## Install

1. In SillyTavern, open **Extensions → Install extension** and paste `https://github.com/dkauser12/rp-director`.
2. For the recommended connection, install the companion server plugin:
   - Copy `server-plugin/` to `SillyTavern/plugins/rp-director-openrouter`.
   - Set `enableServerPlugins: true` in `config.yaml`.
   - Restart SillyTavern.

   The plugin calls OpenRouter with the key already saved in SillyTavern, so the key never reaches the browser.
3. The Director is on by default. In the Extensions panel, the **RP Director** drawer shows its status. **Open Director → Settings** shows the connection.

## How a turn works

Press Send as usual. Within a wait budget (default 10 seconds), the judge:
- finds the exact sentence of your message that is an attempt;
- works out who is acting and on whom;
- judges the odds from the evidence that kind of move allows.

Your outcome table turns the odds into a result, with dice if you use them. The writer then gets the ruling with the characters' state and the lore the scene needs. Dialogue, feelings and routine actions are not attempts, so most turns have no ruling.

Anything the judge can't settle in time is left **unruled**. The writer simply isn't told a ruling, and your reply is never held up. A failure shows one notice per kind of failure, and a badge offering **Try the judge again**.

Each reply gets a badge, such as "Director · at a price · 34% · rolled 52". Click it to see the move, the ruling, state changes and lore, with **Roll again**, **Reassess** and **Open Activity**.

**Swipes keep what was decided.** A ruling belongs to your message, not to one reply:
- Swiping a ruled reply asks first: **Keep the result**, **Roll again** (new dice, same odds) or **Cancel**. You can turn the question off in Settings.
- Swipes of other replies and Continue reuse the turn's decisions silently.
- **Regenerate** asks the same question and keeps the ruling of the reply you were looking at. If Roll again fails there, the reply keeps its result.
- **Reassess** asks the judge for a new ruling on the same evidence.
- While a reply, swipe or automatic rewrite is still being written, Roll again and Reassess ask you to wait.

## Modules

Each module is a switch in **Open Director → Settings**. With every module off, the Director stands aside and makes no requests.

| Module | What it does | Requests per turn |
|---|---|---|
| Speaker | Picks who replies in a group chat. | 1, in parallel |
| Decisions | Rules on attempts, and offers the writer an NPC-action tool whose rolls you can review before the writer continues. | 1 with no attempt, 3 for an attempt |
| Meters | Places each character on the genre pack's meters, at most one step per turn. | 1, in parallel |
| Secrets | Tells the writer who knows each secret, and records reveals. | Shares the Meters request |
| NPC reactions | On turns without a ruling, draws how a character responds: presses, changes tactic, keeps or lets slip a secret. | Rides in the move request |
| Lore | Picks the lorebook entries the turn depends on. | 1–3, in parallel |
| Pacing | Names the scene type and keeps beats short, never skipping time. It can also hand the turn back at the first beat where you must act. | Shares a parallel request |
| Reply check | Checks each reply. Writing for {{user}} or breaking the ruling gets one corrected swipe per user turn, and the original stays among the swipes. Ignoring {{user}} or repeating gets a nudge next turn. | 1 after each reply |

The pacing texts and the reply-check thresholds are editable. Hand-back beats add the Dynamic Response extension's cue tag only when that extension is installed and enabled.

**Automatic corrections:**
- They are skipped in group chats and when swipes are off.
- A correction is cancelled if you type, press Stop, swipe, edit or change chat before its text arrives, and you stay on the wording you were answering.
- It always keeps the ruling of the reply it checked.

**The workspace** (Open Director, the wand menu or `/director`) has five tabs:
- **This chat:** genre pack, meters, secrets, the latest lore picks, and the next speaker.
- **Activity:** the last 20 replies, each with its move, ruling, changes, requests, time and cost.
- **Outcomes:** the outcome table and the method (Threshold or Dice).
- **Lore:** per-book modes.
- **Settings.**

**Costs:** Activity shows OpenRouter's reported cost and tokens for every Director request. The badge popup shows the turn's total, and Settings shows the session's.

## Presets: macros and commands

Presets and trackers can read the Director's decisions through SillyTavern's macro engine, including inside `{{if}}` conditions and `{{setvar}}` values.
- Each reader gives the value for the generation being built: after the judge on Send, the frozen value on swipes and Continue, and the new draw after Roll again.
- A reader is empty when there's no value, when the Director is off, paused or standing aside, and outside a generation (so `/director-get` in a script run by hand returns nothing).

| Macro | Value |
|---|---|
| `{{director::outcome}}` | The result, such as `at a price` |
| `{{director::odds}}` | The odds, such as `34%` |
| `{{director::roll}}` | The roll, such as `52/100`. Even `0/100` counts as true in `{{if}}`. |
| `{{director::scene}}` | `combat`, `conversation`, `travel`, `intimate` or `downtime` |
| `{{director::pack}}` | The chat's genre pack |
| `{{director::meter::Guide::regard}}` | A character's level on a meter, such as `warm` (empty if two characters share the name) |
| `{{director::active}}` | `true` when anything from the Director is in this prompt |
| `{{director::module::decisions}}` | `true` when that module's output is in this prompt |

- **Module names:** `speaker`, `decisions`, `meters`, `secrets`, `lore`, `reactions`, `pacing` and `replyCheck`.
- **Fallback guards:** `module::decisions` is `true` whenever the decisions module ran without failing:
  - a ruling, or an NPC result that was kept;
  - no attempt;
  - a hand-off;
  - an out-of-character message.

  It is empty when the judge couldn't rule, so a preset can keep its own dice as a fallback: `{{if !{{director::module::decisions}}}}…{{/if}}`.
- **When the extension is missing:** SillyTavern leaves an unknown macro as raw text, which counts as true. A guard that must also hold when the extension is disabled or uninstalled should compare instead:

  ```text
  {{setvar::rpd_on::{{director::active}}}}{{if {{.rpd_on == true}}}}Director is running{{else}}fallback{{/if}}
  ```

**Prompt cache:** put readers in in-chat prompts at depth 0 or 1. A reader above the chat history changes the start of the prompt every turn, which throws away the writer's cache. The Director's own instructions always sit at the end of the prompt.

| Command | Action |
|---|---|
| `/director [chat\|activity\|outcomes\|lore\|settings]` | Open the workspace |
| `/director-pause on\|off` | Pause or resume the Director in this chat |
| `/director-reroll` | Roll again and write a new swipe |
| `/director-reassess` | Ask for a new ruling and write a new swipe |
| `/director-pack <id\|auto>` | Choose the chat's genre pack |
| `/director-speaker <name\|auto\|yield>` | Choose who speaks in the next reply only (`yield` hands the turn to {{user}}) |
| `/director-get <macro key>` | Return a reader's value, for example `meter::Guide::regard` |

## Lore selection

Keyword lore fires on words, not on what the scene needs. A single mention can cascade through recursion into most of a book. The Lore module asks the judge instead:
- It walks each book as a tree, using TunnelVision's index for books over 40 entries.
- It keeps at most five entries.
- Each book's mode decides who gets the picks:

| Mode | Rulings | Writer |
|---|---|---|
| Off | ignore the book | keyword activation |
| Rulings only | read the picks | keyword activation |
| Rulings + writer (default) | read the picks | keyword activation plus the picks |
| Director decides | read the picks | only the picks (constant entries stay on) |

Each book also shows what the last reply's keyword scan put into the prompt from it, so you can see which books are worth switching to Director decides. If the lore stage fails, the turn goes on with keyword lore.

## Genre packs

A pack defines what counts as an attempt, the kinds of attempt, and the meters. The judge picks one on a chat's first turn (Auto), and you can change it in **This chat**.

| Pack | Good for | Meters |
|---|---|---|
| General | Anything | regard |
| Romance & slice of life | Closeness, attraction, teasing | regard, nerve |
| Adventure & kingdom | Danger, magic, fights, rulers | loyalty, morale |
| Investigation & intrigue | Clues, interrogations, hacks | trust, suspicion |
| Politics & factions | Deals, coercion, schemes | standing, fear |

Meters are plain scales, for example regard runs cold, guarded, friendly, warm, smitten. **Only the judge sets them, from what happens in play.** The writer plays each character at their level, and rulings on requests take that level into account. Add your own packs in `profiles/local/packs.json`, in the same format as `src/pack/packs.ts`.

## The detection firewall

- Finding the move and routing it use only the public transcript: no character cards and no secrets.
- Collapsed `<details>` blocks, such as private thoughts and trackers, never reach the judge.
- A ruling on an attempt to *discover* something never sees cards, meters, secret text or private lore. The judge can't hand you a truth the scene hasn't shown.

## Connections

- **OpenRouter through the server plugin** (recommended; see Install).
- Under **Settings → Advanced**:
  - Jev's native endpoint, with a key kept for the session only.
  - A structured judge: any OpenAI-compatible model, through a SillyTavern connection profile.

## Privacy

Cards, chats, keys, settings and personal presets are private data. They do not belong in this repository or in issues. Keep personal outcome presets and packs in the gitignored `profiles/local/` folder.

## Upgrading from 0.7

- **Settings** move to the staged pipeline. The post-reply observer and its connection are gone; Reply check replaces them.
- **Chat records** are converted when a chat is first saved:
  - A copy of the old record, without its diagnostic history, stays in the chat's metadata as `rpDirector_0_7_backup`.
  - To go back to 0.7, export the chat first, restore the copy as `rpDirector`, and install 0.7.1. The copy holds the record from before the first 0.8 save, so turns played under 0.8 are not in it.
  - **Settings → Advanced → Remove the 0.7 rollback copy** deletes the copy once you're sure.
- **Old footers:** the Director's text footers are removed from old replies once. That change to the prompt makes the writer's cache miss once for that chat.

## Development

```text
npm install
npm run verify      # typecheck, unit tests and build
```

SillyTavern loads the bundle `index.js`. Sources are in `src/`, and tests are in `tests/unit/`:
- `src/controller.ts`: the turn lifecycle.
- `src/pipeline/`: the judge's stages.
- `src/story.ts`: each chat's pack, meters, secrets and lore picks.
- `src/lore/`: lore trees and per-book modes.
- `src/pack/`: genre packs.
