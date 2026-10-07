/**
 * Built-in genre packs and the pack registry. Local packs load from the
 * gitignored profiles/local/packs.json through the same seam as local presets:
 * fetched at runtime, validated, never compiled into the bundle.
 */
import type { GenrePack } from './pack.ts';
import { DEFAULT_PACK, HANDOFF_LINE, ROUTINE_LINE, SMALL_TALK_LINE, deepFreeze, validatePack } from './pack.ts';

const ROMANCE: GenrePack = {
  id: 'romance',
  version: 3,
  label: 'Romance & slice of life',
  description: 'Closeness, attraction, teasing and pursuit between people. Rules asks, pressure and resistance; tracks how each character feels about the player and how boldly they pursue it.',
  actors: { kinds: ['player', 'npc'], rulableOwners: ['player', 'npc'] },
  gate: {
    include: [
      'Asking or pressing someone for something they might refuse: a favour, a touch, closeness, permission, a confession, that they stay or leave.',
      'Trying to change how someone behaves toward the player right now: teasing, charming, provoking, reassuring or apologising.',
      'Resisting someone else\'s pressure, hiding something or lying, or reading what someone is hiding.',
      'Physical actions whose outcome is genuinely uncertain and matters, such as getting somewhere first or moving someone.',
      HANDOFF_LINE,
    ],
    exclude: [SMALL_TALK_LINE, ROUTINE_LINE],
  },
  protected: [],
  families: [
    { key: 'ask', label: 'Ask or press', kind: 'change', evidence: ['transcript', 'lore', 'target_card', 'meters'],
      definition: 'Ask, invite, bargain for or press someone for one specific thing they might refuse, now.',
      successSemantics: 'The target agrees to the specific thing and does it now, in their own way; the player\'s answer to any counter-offer is not decided.' },
    { key: 'sway', label: 'Sway', kind: 'change', evidence: ['transcript', 'lore', 'target_card', 'meters'],
      definition: 'Change how someone behaves toward the player in the moment: tease, charm, provoke, reassure, apologise, win them over.',
      successSemantics: 'The target visibly responds the way the player was trying for in this exchange; the moment changes, not a lasting attitude.' },
    { key: 'hold_out', label: 'Hold out', kind: 'change', evidence: ['transcript', 'lore', 'owner_card', 'target_card', 'meters'],
      definition: 'Resist pressure, refuse, keep a boundary, or keep control of a situation someone else is pushing.',
      successSemantics: 'The one resisting holds their ground in this exchange; the pressure does not get what it sought now.' },
    { key: 'conceal', label: 'Hide or lie', kind: 'change', evidence: ['transcript', 'lore', 'owner_card', 'target_card', 'meters'],
      definition: 'Hide something, lie, cover a slip, or keep up an alibi in front of someone.',
      successSemantics: 'The concealment holds now against the people present, judged by what they could see or check.' },
    { key: 'read', label: 'Read someone', kind: 'discovery', evidence: ['transcript', 'lore'],
      definition: 'Notice a tell, catch a lie, or work out what someone wants or is hiding from what they show.',
      successSemantics: 'The observer works out the specified thing now from what the person visibly shows; hidden truth that nothing in the scene has shown is not evidence.' },
    { key: 'act', label: 'Physical action', kind: 'change', evidence: ['transcript', 'lore', 'owner_card', 'target_card'],
      definition: 'Do something physical or practical whose outcome is uncertain: get somewhere first, move someone, catch, fix, win a game.',
      successSemantics: 'The concrete action produces the stated result now, given the people and conditions present.' },
  ],
  meters: [
    { key: 'regard', label: 'regard for {{player}}', about: 'How the character feels about the player right now: affection, attraction and trust together.', levels: ['cold', 'guarded', 'friendly', 'warm', 'smitten'], initial: 2 },
    { key: 'nerve', label: 'nerve', about: 'How boldly the character goes after what they want with the player right now.', levels: ['withdrawn', 'hesitant', 'steady', 'bold', 'relentless'], initial: 2 },
  ],
};

const ADVENTURE: GenrePack = {
  id: 'adventure',
  version: 3,
  label: 'Adventure & kingdom',
  description: 'Danger, skill, force, magic and rule. Rules physical, magical and social risks, including orders given to followers; tracks loyalty and morale.',
  actors: { kinds: ['player', 'npc'], rulableOwners: ['player', 'npc'] },
  gate: {
    include: [
      'Overcoming danger or an obstacle, including with magic; fighting, forcing or outmanoeuvring opposition; escaping or resisting; sneaking, hiding or deceiving; searching or discovering; persuading, commanding, bargaining with or intimidating someone into a specific action; seizing or securing something.',
      HANDOFF_LINE,
    ],
    exclude: [SMALL_TALK_LINE, ROUTINE_LINE],
  },
  protected: [],
  families: [
    { key: 'overcome_operate', label: 'Overcome', kind: 'change', evidence: ['transcript', 'lore', 'owner_card'],
      definition: 'Overcome danger or an obstacle, cast or channel magic, climb, cross, repair, craft or break something.',
      successSemantics: 'The method, given the actor\'s established skill, power, tools and conditions, produces the specified result now.' },
    { key: 'contest_impose', label: 'Fight or force', kind: 'change', evidence: ['transcript', 'lore', 'owner_card', 'target_card', 'meters'],
      definition: 'Attack, grapple, restrain, seize, break through, or outmanoeuvre active opposition.',
      successSemantics: 'The acting side overcomes the opposition in this one exchange; the same fight is not resolved twice.' },
    { key: 'evade_resist', label: 'Escape or resist', kind: 'change', evidence: ['transcript', 'lore', 'owner_card', 'target_card', 'meters'],
      definition: 'Escape, dodge, endure, shake off a spell or poison, or avoid an imposed consequence.',
      successSemantics: 'The actor avoids or withstands the specified consequence in this exchange.' },
    { key: 'conceal_deceive', label: 'Sneak or deceive', kind: 'change', evidence: ['transcript', 'lore', 'owner_card', 'target_card', 'meters'],
      definition: 'Sneak, hide, disguise, lie, misdirect or steal unnoticed.',
      successSemantics: 'The deception or stealth holds now against those present, judged by what they could perceive or check.' },
    { key: 'detect_discover', label: 'Search or discover', kind: 'discovery', evidence: ['transcript', 'lore'],
      definition: 'Search, track, scout, notice a threat, read a tell, or uncover a hidden fact.',
      successSemantics: 'The searcher establishes the specified fact now from what can actually be seen, heard or found; hidden truth that nothing in the scene has shown is not evidence.' },
    { key: 'influence_negotiate', label: 'Persuade or command', kind: 'change', evidence: ['transcript', 'lore', 'target_card', 'meters'],
      definition: 'Persuade, command, bargain with or intimidate someone into one specific action now.',
      successSemantics: 'The target does the specific thing now; loyalty or a lasting change of heart is not decided.' },
    { key: 'acquire_secure', label: 'Secure', kind: 'change', evidence: ['transcript', 'lore', 'owner_card', 'target_card', 'meters'],
      definition: 'Seize, claim or secure a place, object, passage, right or commitment.',
      successSemantics: 'The specified place, object, right or commitment is secured now.' },
  ],
  meters: [
    { key: 'loyalty', label: 'loyalty to {{player}}', about: 'How far the character will follow and support the player right now.', levels: ['hostile', 'resentful', 'dutiful', 'loyal', 'devoted'], initial: 2 },
    { key: 'morale', label: 'morale', about: 'How confident the character is and how willing to face danger right now.', levels: ['broken', 'shaken', 'steady', 'confident', 'fearless'], initial: 2 },
  ],
};

const INVESTIGATION: GenrePack = {
  id: 'investigation',
  version: 3,
  label: 'Investigation & intrigue',
  description: 'Clues, lies, surveillance and leverage. Rules searches, interrogations, cover stories and hacks; tracks trust and suspicion of the player.',
  actors: { kinds: ['player', 'npc'], rulableOwners: ['player', 'npc'] },
  gate: {
    include: [
      'Searching, examining, analysing or tracing something; questioning or pressuring someone for a specific answer; lying, hiding or keeping a cover; breaking into or operating systems and devices; confronting, restraining or escaping someone.',
      HANDOFF_LINE,
    ],
    exclude: [SMALL_TALK_LINE, ROUTINE_LINE],
  },
  protected: [],
  families: [
    { key: 'examine', label: 'Examine or trace', kind: 'discovery', evidence: ['transcript', 'lore'],
      definition: 'Examine, search, analyse, trace or read someone or something to establish a hidden fact.',
      successSemantics: 'The investigator establishes the specified fact now from what can actually be observed, measured or traced; hidden truth that nothing in the scene has shown is not evidence.' },
    { key: 'question', label: 'Question', kind: 'change', evidence: ['transcript', 'lore', 'target_card', 'meters'],
      definition: 'Question, interrogate or pressure someone into giving a specific answer or piece of information now.',
      successSemantics: 'The target gives the specific answer now; its truth is only what they believe or choose to say.' },
    { key: 'cover', label: 'Keep a cover', kind: 'change', evidence: ['transcript', 'lore', 'owner_card', 'target_card', 'meters'],
      definition: 'Lie, hide, bluff, plant a false trail or keep up a cover in front of someone.',
      successSemantics: 'The cover holds now against the people present, judged by what they could perceive, check or sense with their own abilities.' },
    { key: 'operate', label: 'Operate or break in', kind: 'change', evidence: ['transcript', 'lore', 'owner_card'],
      definition: 'Hack, bypass, break into, repair or operate a system, device or lock.',
      successSemantics: 'The method, given the actor\'s established skill and tools, produces the specified result now.' },
    { key: 'confront', label: 'Confront', kind: 'change', evidence: ['transcript', 'lore', 'owner_card', 'target_card', 'meters'],
      definition: 'Fight, restrain, seize or outmanoeuvre someone who resists.',
      successSemantics: 'The acting side overcomes the resistance in this one exchange.' },
    { key: 'evade', label: 'Evade', kind: 'change', evidence: ['transcript', 'lore', 'owner_card', 'target_card'],
      definition: 'Escape, slip surveillance, withstand an intrusion or avoid an imposed consequence.',
      successSemantics: 'The actor avoids or withstands the specified consequence in this exchange.' },
    { key: 'persuade', label: 'Persuade', kind: 'change', evidence: ['transcript', 'lore', 'target_card', 'meters'],
      definition: 'Persuade, bargain with or pressure someone into one specific action now.',
      successSemantics: 'The target chooses the specified action now, given their interests and leverage.' },
  ],
  meters: [
    { key: 'trust', label: 'trust in {{player}}', about: 'How much the character trusts the player right now.', levels: ['hostile', 'distrustful', 'wary', 'trusting', 'confiding'], initial: 2 },
    { key: 'suspicion', label: 'suspicion of {{player}}', about: 'How strongly the character suspects the player is hiding something or is not what they seem.', levels: ['unsuspecting', 'curious', 'suspicious', 'alarmed', 'certain'], initial: 0 },
  ],
};

const POLITICS: GenrePack = {
  id: 'politics',
  version: 3,
  label: 'Politics & factions',
  description: 'Deals, pressure, law and intelligence between powers. Rules negotiations, coercion, decrees and schemes; tracks each character\'s standing with the player and fear of them.',
  actors: { kinds: ['player', 'npc'], rulableOwners: ['player', 'npc'] },
  gate: {
    include: [
      'Negotiating terms; threatening, pressuring or blackmailing someone into compliance; pushing a law, order or appointment through resistance; hiding a plan, planting a story or bribing without being traced; gathering intelligence on another power; using force.',
      HANDOFF_LINE,
    ],
    exclude: [SMALL_TALK_LINE, ROUTINE_LINE],
  },
  protected: ['Loyalty and long-term allegiance are not decided by a single ruling.'],
  families: [
    { key: 'negotiate', label: 'Negotiate', kind: 'change', evidence: ['transcript', 'lore', 'target_card', 'meters'],
      definition: 'Bargain or negotiate with someone for specific terms or a commitment now.',
      successSemantics: 'The counterpart accepts the specific terms now; the player\'s acceptance of altered terms is not decided.' },
    { key: 'coerce', label: 'Coerce', kind: 'change', evidence: ['transcript', 'lore', 'target_card', 'meters'],
      definition: 'Threaten, pressure or blackmail someone into specific compliance now.',
      successSemantics: 'The target complies with the specific demand now.' },
    { key: 'decree', label: 'Push a measure', kind: 'change', evidence: ['transcript', 'lore', 'owner_card'],
      definition: 'Push through a law, order, appointment or policy against institutional resistance.',
      successSemantics: 'The measure takes effect as specified now.' },
    { key: 'scheme', label: 'Scheme', kind: 'change', evidence: ['transcript', 'lore', 'owner_card', 'target_card', 'meters'],
      definition: 'Hide a plan, plant a story, forge, bribe or manoeuvre without being traced.',
      successSemantics: 'The scheme proceeds untraced now, judged by what the other powers could perceive or check.' },
    { key: 'intel', label: 'Gather intelligence', kind: 'discovery', evidence: ['transcript', 'lore'],
      definition: 'Gather intelligence, or uncover what another power is planning or hiding.',
      successSemantics: 'The specified fact is established now through admissible evidence, never through another power\'s hidden truth.' },
    { key: 'force', label: 'Use force', kind: 'change', evidence: ['transcript', 'lore', 'owner_card', 'target_card'],
      definition: 'Use force: arrest, seize, suppress, attack or defend.',
      successSemantics: 'The acting side achieves the specified result against the opposition in this exchange.' },
  ],
  meters: [
    { key: 'standing', label: 'regard for {{player}}\'s authority', about: 'How far the character accepts the player\'s authority right now.', levels: ['defiant', 'reluctant', 'compliant', 'supportive', 'devoted'], initial: 2 },
    { key: 'fear', label: 'fear of {{player}}', about: 'How much the character fears what the player could do to them right now.', levels: ['contemptuous', 'unafraid', 'wary', 'afraid', 'terrified'], initial: 1 },
  ],
};

export const BUILT_IN_PACKS: readonly GenrePack[] = deepFreeze([DEFAULT_PACK, ROMANCE, ADVENTURE, INVESTIGATION, POLITICS]) as readonly GenrePack[];

const localPacks: GenrePack[] = [];

export function listPacks(): GenrePack[] {
  return [...BUILT_IN_PACKS, ...localPacks];
}

/** The pack with this id, or the default pack. */
export function packById(id: string | null | undefined): GenrePack {
  return listPacks().find(p => p.id === id) ?? DEFAULT_PACK;
}

export function hasPack(id: string): boolean {
  return listPacks().some(p => p.id === id);
}

export interface LocalPackLoadResult { loaded: string[]; warnings: string[] }

/** Validates and registers local packs ({ schemaVersion: 1, packs: GenrePack[] }). */
export function registerLocalPacks(raw: unknown): LocalPackLoadResult {
  const loaded: string[] = [];
  const warnings: string[] = [];
  const doc = raw as { schemaVersion?: unknown; packs?: unknown } | null;
  if (!doc || typeof doc !== 'object' || doc.schemaVersion !== 1 || !Array.isArray(doc.packs)) return { loaded, warnings: ['local pack document needs schemaVersion 1 and a packs array'] };
  for (const [index, candidate] of doc.packs.entries()) {
    const pack = structuredClone(candidate) as GenrePack;
    const id = String(pack?.id ?? `#${index + 1}`);
    if (listPacks().some(p => p.id === id)) { warnings.push(`pack ${id}: duplicate id`); continue; }
    // Old local packs remain usable; remove only the retired observer evidence
    // on this copy, then validate every other source and detection protection.
    let removedFacts = false;
    if (Array.isArray(pack?.families)) for (const family of pack.families) {
      if (!Array.isArray(family?.evidence)) continue;
      const evidence = family.evidence.filter(source => String(source) !== 'state');
      removedFacts ||= evidence.length !== family.evidence.length;
      family.evidence = evidence;
    }
    const check = validatePack(pack);
    if (!check.ok) { warnings.push(`pack ${id}: ${check.errors.join('; ')}`); continue; }
    if (removedFacts) warnings.push(`pack ${id}: removed retired tracked-facts evidence; transcript and other allowed sources remain`);
    localPacks.push(deepFreeze(pack));
    loaded.push(id);
  }
  return { loaded, warnings };
}

/** Missing local data is normal. Invalid data is ignored and reported. */
export async function loadLocalPacks(fetcher: typeof fetch = fetch): Promise<LocalPackLoadResult> {
  try {
    const url = new URL('./profiles/local/packs.json', import.meta.url);
    const response = await fetcher(url.href, { cache: 'no-store', credentials: 'same-origin' });
    if (response.status === 404) return { loaded: [], warnings: [] };
    if (!response.ok) return { loaded: [], warnings: [`local pack fetch failed: HTTP ${response.status}`] };
    const body = await response.text();
    if (body.length > 262144) return { loaded: [], warnings: ['local pack document exceeds 256 KiB'] };
    return registerLocalPacks(JSON.parse(body));
  } catch (error) {
    return { loaded: [], warnings: [`local pack load failed: ${error instanceof Error ? error.message : String(error)}`] };
  }
}
