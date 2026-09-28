import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fillPlaceholders, placeholderValues } from '../../src/prompts.ts';
import { AUTOMATIC_GAIN, attemptLabel } from '../../src/templates.ts';

test('the review popup names the attempt in the player\'s own words when the gain is automatic', () => {
  const label = attemptLabel(AUTOMATIC_GAIN, '"Okay, but no.   Emmy, that was like, half the fun when we used to wrestle." I shrug.');
  assert.equal(label, 'attempt: "Okay, but no. Emmy, that was like, half the fun when we used to wrestle." I shrug.');
  assert.ok(!label.includes(AUTOMATIC_GAIN));
});

test('long automatic attempts are shortened, declared gains are shown as written', () => {
  const long = 'x'.repeat(400);
  const label = attemptLabel(AUTOMATIC_GAIN, long);
  assert.ok(label.length < 200, String(label.length));
  assert.ok(label.endsWith('…'));
  assert.equal(attemptLabel('Get past the gate guard', 'I show my forged pass.'), 'Get past the gate guard');
});

test('instructions shown for review have every placeholder filled, the same way the writer sees them', () => {
  const values = placeholderValues({ requestedGain: 'Get past the gate', attemptedAction: 'I show my pass' }, [], 'Oren', 'Jordan');
  assert.deepEqual(values, { gain: 'Get past the gate', action: 'I show my pass', target: 'Oren', player: 'Jordan', speaker: 'Oren' });
  const text = fillPlaceholders('{{target}} refuses {{player}}: {{gain}} ({{action}}) as {{speaker}}.', values);
  assert.equal(text, 'Oren refuses Jordan: Get past the gate (I show my pass) as Oren.');
  assert.deepEqual(placeholderValues({ requestedGain: 'g', attemptedAction: 'a' }, ['Mira', 'Tessa'], null, 'P').target, 'Mira and Tessa');
  assert.equal(placeholderValues({ requestedGain: 'g', attemptedAction: 'a' }, [], null, 'P').target, 'the other character');
});
