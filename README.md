# RP Director

A SillyTavern extension that makes a separate decision model (TypeSafe **Jev**) the referee of your roleplay. It decides the things a writer model should not decide for itself: whether an attempt succeeds, who speaks next, how each character feels about you, and who knows which secret. Its decisions are frozen before the writer runs and handed to the writer as instructions, so they change the prose. They are not suggestions.

The writer never grades its own homework. Jev only picks from options, scores, or gives a probability; code turns those answers into rulings, and dice (when enabled) add real uncertainty.

## Install

RP Director requires a current SillyTavern installation.

1. Open **Extensions** in SillyTavern.
2. Choose **Install extension**.
3. Paste `https://github.com/dkauser12/rp-director`.
4. Reload SillyTavern, open **RP Director**, choose a connection, and run its connection test before enabling it for a chat.

For **OpenRouter Jev Decisions**, also install the companion plugin described below and restart SillyTavern.

Code maps judge outputs through the editable outcome table, freezes the ruling before prose, and forces the selected group member to write the reply. Wording swipes reuse the ruling and any permit without another tool or decision call; explicit rerolls create linked rulings.

## What happens when you press Send

With the default **staged** pipeline, each turn runs a few small, independent judge requests (about a third of a second each):

1. **Move.** The judge selects the exact sentence of your message that is the move, never a paraphrase. Dialogue, feelings and routine actions are not moves.
2. **Routing.** Who is acting, on whom, and what kind of move it is. Three cases matter:
   - **Your attempt** ("I pick the lock", "I ask her to stay") is ruled.
   - **An order to a character** ("Mira, pick that lock") is ruled with that character acting, and that character writes the reply.
   - **A hand-off** ("go ahead, make me") is not a check. The character you handed the initiative to answers with a frozen reaction: takes the lead, raises the stakes, hands it back with a condition, or declines.
3. **Ruling.** One probability that the move succeeds, judged only on the evidence its kind allows. That probability goes through your outcome table, with dice if you use them.
4. **Character state** (in parallel). The judge places each character on the genre pack's meters and records whether any secret was revealed.
5. **Lore** (in parallel). The judge walks the lorebooks of the chat's cast and picks the entries this turn depends on. Rulings read them; depending on each book's mode, the writer gets them too.
6. **Write.** The writer gets the ruling, the character state, the knowledge boundaries and the picked lore, and writes the reply.

Anything the judge cannot pin down is left **unruled**, and the writer is simply not told a ruling. There is never a default "not yet".

**Swipes** and continues reuse the frozen decisions and the lore picks for free. **Reroll** re-rolls the dice on the same odds. **Reassess** asks only the ruling again, on the same frozen evidence.

## Modules

Every suite is a switch in **Settings → RP Director → Modules**. Turn off what you do not want; with everything off, the Director stands aside and makes no requests.

| Module | What it does | Cost per turn |
|---|---|---|
| Speaker | Picks who replies in a group chat. Off: SillyTavern picks. | 1 request, run in parallel |
| Decisions | Rules on attempts (move → routing → ruling) and offers the writer an NPC-action tool. | 1 when there is no move; 3 for an attempt |
| Meters | Judges each character's meters, at most one step at a time. | 1 request, run in parallel |
| Secrets | Tells the writer who knows each secret and records reveals. | Shares the meters request |
| NPC reactions | On turns with no ruling, draws how a character responds: presses, changes tactic, keeps or lets slip a secret, notices. | Rides in the move request |
| Lore | Picks the lorebook entries the turn depends on, for rulings and (per book) the writer. | 1–3 requests, run in parallel |

## Lore selection

Keyword lore fires on words, not on what the scene needs. One mention of a main character can cascade through recursion into most of a book: in one test chat, a single line naming a main character activated 94 entries (10,617 tokens) on every generation. The Lore module asks the judge instead.

Each turn, beside the move stages, the judge walks each book as a tree: TunnelVision's index when you have built one and the book is larger than 40 entries, otherwise the entries themselves. Each level is one request; every book's frontier is a separate question in it. The judge's distribution is kept as a narrow beam (the options clearly in the running, at most three per level), a section that turns out empty makes the walk try the next-best section once, and at most five entries are kept. On the same line the picks were the gyroscope installation, Kestrel's physical specifications and the installation's success, in 2 requests and about half a second.

Per book, in **Lore selection**:

| Mode | Rulings | Writer |
|---|---|---|
| Off | ignore the book | SillyTavern's keyword activation |
| Rulings only | read the picks | SillyTavern's keyword activation |
| Rulings + writer (default) | read the picks | keyword activation plus the picks |
| Director decides | read the picks | only the picks (the book's constant entries stay on) |

Each book row also shows what the last reply's World Info scan put into the prompt from that book (entries and an estimate of tokens), so you can see which books are worth switching to **Director decides**.

A group chat's World Info only ever loads the speaking character's books, so a pick from another member's book reaches rulings but not the writer. SillyTavern still applies each entry's disable switch, triggers and character filter to the picks. If TunnelVision is switched on and managing a book, the Director only reads that book for rulings. If the lore stage fails, the turn goes on with SillyTavern's keyword lore.

**Public** books may inform discovery rulings (searching, reading someone). Everything else stays out of them: lore often holds secrets and authorial truth, and a discovery ruling must not hand you what the scene has not shown. Public and private books are walked in separate requests for the same reason.

## Genre packs

A pack defines what counts as a move, the kinds of move and what success means for each, and the meters. Each chat has its own pack. The default is **Auto**, where the judge picks one on the chat's first turn and keeps it. Change it any time in **This chat**.

| Pack | Good for | Meters |
|---|---|---|
| General | Anything | regard |
| Romance & slice of life | Closeness, attraction, teasing, pursuit | regard, nerve |
| Adventure & kingdom | Danger, magic, fights, rulers and followers | loyalty, morale |
| Investigation & intrigue | Clues, interrogations, cover stories, hacks | trust, suspicion |
| Politics & factions | Deals, coercion, decrees, schemes | standing, fear |

Meters are plain-language scales, for example regard: cold / guarded / friendly / warm / smitten. **The judge sets them from what happens in play; the writer never does**, and they never jump more than one step in a turn. The writer is told to play each character at their level, and rulings on requests or pressure take the target's level into account.

You can add your own packs in `profiles/local/packs.json` (same format as the built-ins in `src/pack/packs.ts`).

## Outcome table and dice

The ruling's probability picks a row of your **outcome table**. Each outcome's instruction tells the writer what happens. The resolution method sits at the top of the table editor: **threshold** takes the row's outcome directly; **sample** (dice) rolls using the row's weights. The method saves as soon as you change it, and loading a preset never changes it.

Staged rulings on social moves usually score between 0.2 and 0.5. Set your table's bands for that range.

## Evidence rules (the detection firewall)

- Move selection and routing see only the public transcript: no character cards, no secrets.
- Collapsed `<details>` blocks (private thoughts, trackers) never reach the judge.
- Rulings on attempts to *discover* something never see character cards, meters or secret text, so the judge cannot hand you hidden truth the scene has not shown.
- Cards, meters and secret text travel only in requests that cannot feed a discovery ruling.
- Lore reaches discovery rulings only from books marked public, picked in a request that listed public books alone.

## Connections

- **OpenRouter Jev Decisions** (recommended): the companion server plugin `plugins/rp-director-openrouter` calls OpenRouter's decisions endpoint with the OpenRouter key already saved in SillyTavern. The key never reaches the browser. Install the plugin directory as `SillyTavern/plugins/rp-director-openrouter`, set `enableServerPlugins: true`, and restart SillyTavern.
- **Jev** (TypeSafe's native endpoint, session-only key), a **structured judge** (any OpenAI-compatible model through a SillyTavern connection profile), and **Mock** (deterministic, for testing).

Invalid, refused or missing answers on the move, routing or ruling stages pause the turn; nothing is guessed. A failed character-state request only keeps the previous state.

## Legacy pipeline

**Modules → Pipeline → Legacy** restores the original one-batch judge: a gate, family and probability over the whole message. Packs, meters and secrets are staged-only.

## Local-only presets

Character cards, chats, local presets, saved keys, and SillyTavern settings do not belong in this repository. Keep personal presets under the gitignored `profiles/local/` directory. API keys are either session-only or remain in SillyTavern's server-side secret store, depending on the selected connection.

## Development

```text
npm install
npm run verify      # typecheck + unit tests + build
```

`index.js` is the built bundle SillyTavern loads; sources are in `src/`, tests in `tests/unit/`. Layout:
- `src/pipeline/`: the staged stages.
- `src/pack/`: genre packs.
- `src/story.ts`: per-chat pack, meters, secrets and lore picks.
- `src/lore/`: lore trees, the beam walk, per-book modes, and the World Info hook.
- `src/controller.ts`: the turn lifecycle.

