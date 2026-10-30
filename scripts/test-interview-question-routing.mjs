import assert from 'node:assert/strict';
import { RemoteQuestionAssembler, resolveAssistanceQuestion, selectLatestRemoteQuestion } from '../src/lib/remoteQuestion.ts';

// Redacted wording/turn boundaries from the failed October30 interview. This
// exercises manual Space/Say selection as well as automatic question assembly.
let sequence = 0;
const base = 1_793_368_800_000;
const seg = (text, offset, speaker='Them', is_final=true, id=String(++sequence)) =>
  ({id,text,timestamp_ms:base+offset,speaker,is_final});
const segments = [seg("I'm good. How are you?", 1000, 'User')];
assert.equal(selectLatestRemoteQuestion(segments, base+2000), null);
assert.throws(() => resolveAssistanceQuestion('Assist', undefined, segments, base+2000), /No complete question/);
const intro = 'I would like to know more about your experience, how and what exactly you have been doing and what kind of clients you have been serving, please go ahead.';
segments.push(seg(intro, 15000));
assert.equal(resolveAssistanceQuestion('Assist', undefined, segments, base+16000), intro);
segments.push(seg('I work on Google Ads and SEO.', 18000, 'User'));
assert.equal(resolveAssistanceQuestion('WhatToSay', undefined, segments, base+50000), intro,
  'The interviewer question remains available while the candidate answers.');
segments.push(seg('Okay, so... have you ever', 90000));
assert.equal(selectLatestRemoteQuestion(segments, base+91000), null, 'Do not answer the bare fragment or the old introduction.');
const completion = 'work with IT companies or IT services providers for their Google Ads and SEO before.';
segments.push(seg(completion, 99700));
const complete = selectLatestRemoteQuestion(segments, base+100000);
assert.match(complete.text, /have you ever work with IT companies.*Google Ads and SEO before/);
assert.equal(resolveAssistanceQuestion('Assist', undefined, segments, base+100000), complete.text);
segments.push(seg('What do you usually do that you are connected with foreign clients?', 105000, 'User'));
assert.equal(resolveAssistanceQuestion('WhatToSay', undefined, segments, base+110000), complete.text,
  'An interrogative inside the candidate answer cannot replace the remote question.');
segments.push(seg('Okay, sounds good.', 115000));
assert.equal(selectLatestRemoteQuestion(segments, base+116000), null, 'An acknowledgement must not requeue the previous question.');
segments.push(seg('at the moment with you so What is your...', 125000));
assert.equal(selectLatestRemoteQuestion(segments, base+126000), null);
segments.push(seg("And, you know, it's been 19 years for me in tech sales and marketing, doing work for employers.", 137000));
assert.equal(selectLatestRemoteQuestion(segments, base+138000), null, 'A background interjection does not complete What is your.');
segments.push(seg("So what's your, that, you know, angle or the unique thing? I'm not asking you to tell me your secret, but what exactly at the high level, what exactly.", 150000));
assert.equal(selectLatestRemoteQuestion(segments, base+151000), null);
segments.push(seg('you do in order to make sure your clients get results out of SEO.', 155000));
assert.match(resolveAssistanceQuestion('Assist', undefined, segments, base+156000), /angle.*clients get results out of SEO/s);
for (const [offset,text] of [
  [170000,'And currently, are you only working for an agency at the moment or doing your own thing as well on the side? How are you managing your time?'],
  [185000,'okay and if i may ask when it comes to ppc or google ads are you only working on google ads or bing ads as well as meta'],
  [200000,'Okay, sounds good. And when it comes to Google Ads, how much of the budget you are managing at the moment?'],
  [215000,'All right, any other question? for a wrap-up.'],
]) {
  segments.push(seg(text, offset));
  assert.equal(resolveAssistanceQuestion('Assist', undefined, segments, base+offset+1000), text);
}
assert.equal(selectLatestRemoteQuestion(segments, base+400000), null, 'A minutes-old caller question expires.');
assert.throws(() => resolveAssistanceQuestion('Assist', undefined, segments, base+400000), /No complete question/);
assert.equal(resolveAssistanceQuestion('AskQuestion', 'What did I do for CHC?', segments, base+400000), 'What did I do for CHC?');
assert.equal(resolveAssistanceQuestion('Recap', undefined, segments, base+400000), undefined);

// Corrections of a final ID replace the earlier fragment; an in-progress new
// remote turn blocks accidental reuse until it is final.
const corrections = [seg('Have you ever', 1000, 'Them', true, 'same'), seg(completion, 12000)];
assert.match(selectLatestRemoteQuestion(corrections, base+13000).text, /Have you ever work with IT/);
corrections.push(seg('What is your SEO approach?', 14000, 'Them', false, 'next'));
assert.equal(selectLatestRemoteQuestion(corrections, base+14500), null);
corrections.push(seg('What is your SEO approach?', 14000, 'Them', true, 'next'));
assert.equal(selectLatestRemoteQuestion(corrections, base+15000).text, 'What is your SEO approach?');
const revisions = [seg('Have you ever', 1000, 'Them', true, 'revision'), seg('Have you ever worked with IT companies before?', 1000, 'Them', true, 'revision')];
assert.equal(selectLatestRemoteQuestion(revisions, base+2000).text, 'Have you ever worked with IT companies before?');

const automatic = new RemoteQuestionAssembler();
assert.equal(automatic.push(seg('Okay, so... have you ever', 1000)), null);
assert.match(automatic.push(seg(completion, 13000)).text, /have you ever work with IT companies/,
  'A 12-second native speech boundary must preserve the incomplete question.');
assert.equal(new RemoteQuestionAssembler().push(seg('you know, why not to meet and find out if you can be a good fit for us.', 1000)), null);
assert.equal(new RemoteQuestionAssembler().push(seg('we are you know open ai partner and we are focusing on implementation', 1000)), null,
  'The filler you know inside we are is not the question are you.');
console.log('Actual interview question routing regression checks passed.');
