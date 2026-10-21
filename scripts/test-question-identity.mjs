import assert from 'node:assert/strict';
import { AutomaticQuestionGate, questionIdentity } from '../src/lib/questionIdentity.ts';

assert.equal(questionIdentity('How do you allocate budget?'), questionIdentity(' HOW do you allocate budget. '));
const gate = new AutomaticQuestionGate();
assert.equal(gate.claim('How do you allocate budget?', 1000), true);
assert.equal(gate.claim('How do you allocate budget.', 1200), false);
assert.equal(gate.claim('Tell me about SEO.', 1300), true);
assert.equal(gate.claim('How do you allocate budget?', 1400), false);
assert.equal(gate.claim('How do you allocate budget?', 11000), true);
assert.equal(gate.claim(' ?', 12000), false);
console.log('Question duplicate-event regression checks passed.');
