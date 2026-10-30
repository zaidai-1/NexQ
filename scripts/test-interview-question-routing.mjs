import assert from 'node:assert/strict';
import { RemoteQuestionAssembler, resolveAssistanceQuestion, selectLatestRemoteQuestion } from '../src/lib/remoteQuestion.ts';
import { handleQuestionCardKey } from '../src/lib/questionInteraction.ts';

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
segments.push(seg('Please go ahead.', 17000));
assert.equal(resolveAssistanceQuestion('Assist', undefined, segments, base+17500), intro,
  'A separate caller hand-off must preserve the complete question for Space.');
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
segments.push(seg('Please go ahead.', 400000));
assert.equal(selectLatestRemoteQuestion(segments, base+401000), null,
  'A hand-off cannot revive an expired question.');
assert.equal(new RemoteQuestionAssembler().push(seg('Please go ahead.', 1000)), null,
  'A hand-off alone is not a question.');

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

// Actual native Whisper split: the alternatives arrived after a question mark
// had already emitted the Google Ads stem. Auto and Space/Say must both use
// the revised full question, rather than losing the suffix or selecting it alone.
const platformStem = 'Okay, and if I may ask, when it comes to PPC or Google Ads, are you only working on Google Ads?';
for (const suffix of ['Bing Ads as well as Meta.', 'Or Bing Ads as well as Meta.',
  'Versus Bing Ads.', 'Including Meta.']) {
  const split = [seg(platformStem, 1000), seg(suffix, 3079)];
  const assembler = new RemoteQuestionAssembler();
  assert.equal(assembler.push(split[0]).text, platformStem);
  const revised = assembler.push(split[1]);
  assert.equal(revised.text, `${platformStem} ${suffix}`);
  assert.equal(resolveAssistanceQuestion('Assist', undefined, split, base+4000), revised.text);
  assert.equal(resolveAssistanceQuestion('WhatToSay', undefined, split, base+4000), revised.text);
  assert(!revised.text.includes('Earlier question:'), 'The list completes the current question.');
}
for (const interruption of [
  seg('I work on Google Ads.', 2000, 'User'),
  seg('Okay, sounds good.', 2000),
  seg('Our team is expanding into other markets.', 2000),
  seg('I use WordPress as well as Shopify.', 2000),
]) {
  const interrupted = [seg(platformStem, 1000), interruption, seg('Bing Ads as well as Meta.', 3000)];
  assert.equal(selectLatestRemoteQuestion(interrupted, base+4000), null,
    'Own speech, acknowledgement or a new statement must break continuation.');
}
assert.equal(selectLatestRemoteQuestion([seg(platformStem, 1000), seg('Bing Ads as well as Meta.', 16001)], base+17000), null,
  'A list suffix cannot revive an older remote turn.');
assert.equal(selectLatestRemoteQuestion([seg(platformStem, 1000), seg('Bing Ads as well as Meta.', 16000)], base+17000).text,
  `${platformStem} Bing Ads as well as Meta.`, 'The same-turn 15-second boundary remains inclusive.');
const multiPartList = new RemoteQuestionAssembler();
for (const [offset,text] of [[1000,'Are you'], [2000,'only working on'], [3000,'Google Ads and']]) {
  assert.equal(multiPartList.push(seg(text, offset)), null);
}
assert(multiPartList.push(seg('Meta or LinkedIn?', 4000)));
assert.equal(multiPartList.push(seg('Or Bing Ads.', 5000)).text,
  'Are you only working on Google Ads and Meta or LinkedIn? Or Bing Ads.',
  'A list suffix must preserve the lead of a four-part emitted question.');

// A focused historical card used to answer its old text on Space and then
// bubble into the global shortcut. Reproduce that real native focus path.
let oldCardSelections = 0;
let currentGenerations = 0;
let propagationStopped = false;
let defaultPrevented = false;
const cardKey = key => ({key, preventDefault: () => {defaultPrevented = true;},
  stopPropagation: () => {propagationStopped = true;}});
handleQuestionCardKey(cardKey(' '), () => {oldCardSelections++;});
if (!propagationStopped) {
  assert.throws(() => resolveAssistanceQuestion('Assist', undefined, segments, base+401000), /No complete question/);
}
assert.equal(oldCardSelections, 0, 'Space must not explicitly resubmit a stale focused card.');
assert.equal(defaultPrevented, false, 'The global current-question shortcut must receive Space.');
handleQuestionCardKey(cardKey(' '), () => {oldCardSelections++;});
if (!propagationStopped) {
  resolveAssistanceQuestion('Assist', undefined, [seg('What did you build in GoHighLevel?', 500000)], base+501000);
  currentGenerations++;
}
assert.equal(currentGenerations, 1, 'Focused-card Space must generate the fresh question once.');
handleQuestionCardKey(cardKey('Enter'), () => {oldCardSelections++;});
assert.equal(oldCardSelections, 1, 'Enter remains an explicit historical-card selection.');
assert.equal(propagationStopped, true);
console.log('Actual interview question routing regression checks passed.');
