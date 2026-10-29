import assert from 'node:assert/strict';
import { RemoteQuestionAssembler } from '../src/lib/remoteQuestion.ts';
let seq = 0;
const seg = (text, timestamp_ms, speaker='Them', is_final=true) => ({id:String(++seq),text,timestamp_ms,speaker,is_final});
const a = new RemoteQuestionAssembler();
assert.equal(a.push(seg('This campaign generates low-quality leads.', 1000)), null);
assert.match(a.push(seg('How would you fix that?', 1800)).text, /campaign generates low-quality leads.*How would you fix that/);
assert.match(a.push(seg('What would you investigate if conversions fell by 40%?', 3000)).text, /^What would you investigate/);
assert.equal(a.push(seg('Let me explain my approach.', 4000, 'You')), null);
assert.equal(a.push(seg('What was the budget that you\'ve', 5000)), null);
assert.equal(a.push(seg('managed and what were your', 6000)), null);
assert.match(a.push(seg('results? Did you overspend or underspend?', 7000)).text, /budget.*managed.*results/);
const b = new RemoteQuestionAssembler();
assert.equal(b.push(seg('How would you fix that?', 1000, 'Them', false)), null);
assert.match(b.push(seg('How would you improve Google Ads?', 2000)).text, /improve Google Ads/);
assert.equal(b.push(seg('How would you improve Google Ads?', 2200)), null);
assert.equal(b.push(seg('Yeah.', 15000)), null);
assert.match(b.push(seg('Tell me about your SEO experience.', 17000)).text, /SEO experience/);
const c = new RemoteQuestionAssembler();
assert.equal(c.push(seg('Campaign conversions suddenly dropped by forty percent.', 1000)), null);
assert.match(c.push(seg('What would you investigate first?', 2000)).text, /conversions suddenly dropped.*investigate first/);
const d = new RemoteQuestionAssembler();
d.push(seg('How would you structure ads for a local service business?', 1000));
d.push(seg('I would prioritize service-area coverage.', 2000, 'You'));
assert.match(d.push(seg('So how would that help the business?', 45000)).text, /local service business.*Current question:.*help the business/s);
d.push(seg('That gives us useful enquiries.', 46000, 'You'));
assert.equal(d.push(seg('Tell me about your WordPress experience.', 48000)).text, 'Tell me about your WordPress experience.');
const e = new RemoteQuestionAssembler();
e.push(seg('Could you briefly tell me about your ad?', 1000));
assert.equal(e.push(seg("budget that you've", 2000)), null);
assert.equal(e.push(seg('managed and what were your', 3000)), null);
assert.match(e.push(seg('results? Did you overspend?', 4000)).text, /Earlier question:.*your ad\?\nCurrent question: budget that you've managed.*results/s);
const f = new RemoteQuestionAssembler();
f.push(seg('How would you improve lead quality?', 1000));
f.push(seg('I would review CRM outcomes.', 2000, 'You'));
assert.match(f.push(seg('Why is that?', 3000)).text, /Earlier question:.*lead quality.*Current question: Why is that/s);
assert.equal(f.push(seg('What about SEO?', 4000)).text, 'What about SEO?');
const g = new RemoteQuestionAssembler();
g.push(seg('Did you apply the 321 negative keywords, and what happened to CPA?', 1000));
assert.equal(g.push(seg('Our Google Ads campaign generates leads. but most are low quality.', 9000)), null);
assert.equal(g.push(seg('How would you fix that?', 12000)).text,
  'Our Google Ads campaign generates leads. but most are low quality. How would you fix that?');
const h = new RemoteQuestionAssembler();
assert.equal(h.push(seg('A booked customer gets the wrong reminder in GoHighLevel.', 1000)), null);
assert.equal(h.push(seg('How would you investigate?', 2000)).text,
  'A booked customer gets the wrong reminder in GoHighLevel. How would you investigate?');
assert.equal(h.push(seg('Tell me about your SEO experience.', 3000)).text,
  'Tell me about your SEO experience.');
for (const diagnostic of ['What would you check?', 'How would you diagnose?', 'How would you test?']) {
  const pending = new RemoteQuestionAssembler();
  pending.push(seg('A booked customer gets the wrong reminder in GoHighLevel.', 1000));
  assert.equal(pending.push(seg(diagnostic, 2000)).text,
    `A booked customer gets the wrong reminder in GoHighLevel. ${diagnostic}`);
}
const i = new RemoteQuestionAssembler();
i.push(seg('Did you apply the 321 negative keywords, and what happened to CPA?', 1000));
i.push(seg('A booked customer gets the wrong reminder in GoHighLevel.', 2000));
assert.equal(i.push(seg('How would you investigate?', 3000)).text,
  'A booked customer gets the wrong reminder in GoHighLevel. How would you investigate?');
// An explicit new topic must still replace an unsubmitted scenario.
const j = new RemoteQuestionAssembler();
j.push(seg('A booked customer gets the wrong reminder in GoHighLevel.', 1000));
assert.equal(j.push(seg('What did you do for CHC Concrete?', 2000)).text,
  'What did you do for CHC Concrete?');
// A generic diagnostic prompt alone must not inherit an answered topic.
assert.equal(j.push(seg('How would you investigate?', 3000)).text, 'How would you investigate?');
console.log('Remote turn assembly regression checks passed.');
