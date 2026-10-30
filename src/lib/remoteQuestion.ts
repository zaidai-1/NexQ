import { questionIdentity } from './questionIdentity.ts';

export type RemoteSegment = { id: string; text: string; speaker: string; timestamp_ms: number; is_final: boolean };
type Segment = RemoteSegment;
export type RemoteQuestion = { text: string; timestamp_ms: number; source: 'Them' | 'Interviewer'; confidence: number; turnId: string };
const TURN_GAP_MS = 15_000; // Whisper can split continuous speech at its 12-second turn limit.

function questionLead(text: string): string {
  return text.replace(/^(?:(?:okay|alright|all right|so|and|uh|um|you know|sounds good)[\s,.:!…-]+)+/i, '');
}

function hasQuestionLead(text: string): boolean {
  const lead = questionLead(text);
  if (/^why not to\b/i.test(lead)) return false; // Rhetorical introduction: "why not to meet and find out ...".
  return /^(?:what|how|why|when|where|who|which|can you|could you|would you|should you|do you|did you|are you|is there|have you|tell me|explain|describe|walk me|give me)\b/i.test(lead);
}

function startsQuestion(text: string): boolean {
  const lead = questionLead(text);
  return hasQuestionLead(text)
    // Real callers embed requests after a conversational lead-in and often
    // Whisper finishes them with a period rather than a question mark.
    || /\b(?:i (?:would like|want) to know|i'd like to know|please (?:explain|describe|tell|share)|any (?:other )?questions?)\b/i.test(lead)
    || /\b(?:what(?:'s| is| are| do| does| would| will| exactly| kind| approach| about| were| was| did| have| has| can| should| your)|how (?:much|many|do|does|would|will|are|is|have|can|could|should|did)|(?:are|do|did|have|will|can|could|would|should) you(?!\s+know\b))\b/i.test(lead);
}

function isIncomplete(text: string): boolean {
  if (/(?:\.\.\.|…)[\s?.!,]*$/.test(text)) return true;
  const ending = text.replace(/[\s?.!,]+$/, '');
  return /\b(you've|you have|your|the|a|and|or|to|of|about|what were your|for example|have you ever|have you|can you|could you|would you|should you|will you|do you|did you|are you|what exactly|how much|how many)$/i.test(ending);
}

function isListContinuation(text: string): boolean {
  const lead = questionLead(text);
  return !startsQuestion(text) && lead.split(/\s+/).length <= 20
    && (/^(?:or|versus|including)\b/i.test(lead) || /\bas well as\b/i.test(lead))
    // Accept a short list suffix, not an acknowledgement or a new statement.
    && !/^(?:yes|yeah|yep|no|nope|sure|thanks?|thank you|sounds good|i|we|they|he|she|it|my|our|their|this|that|the|an?)\b/i.test(lead)
    && !/\b(?:is|are|was|were|has|have|had|will|would|can|could|should|do|does|did)\b/i.test(lead)
    && !/[.!?]\s+\S/.test(lead);
}

/** Assemble final remote STT segments; never split one turn into sentence questions. */
export class RemoteQuestionAssembler {
  private parts: Segment[] = [];
  private priorQuestion: RemoteQuestion | null = null;
  private context = '';
  private emittedParts = 0;
  private currentQuestion: RemoteQuestion | null = null;

  /** A newer remote statement or unfinished question supersedes the old one. */
  getCurrentQuestion(): RemoteQuestion | null {
    return this.currentQuestion;
  }

  push(segment: Segment): RemoteQuestion | null {
    if (!segment.is_final) {
      if ((segment.speaker === 'Them' || segment.speaker === 'Interviewer') && segment.text.trim()) {
        this.currentQuestion = null;
      }
      return null;
    }
    if (segment.speaker !== 'Them' && segment.speaker !== 'Interviewer') {
      this.parts = [];
      this.context = '';
      this.emittedParts = 0;
      return null;
    }
    const text = segment.text.trim();
    if (!text) return null;
    // Whisper may put a caller's invitation in its own final segment. It is
    // the hand-off for the current question, not a replacement statement.
    if (this.currentQuestion
      && segment.timestamp_ms - this.currentQuestion.timestamp_ms <= 120_000
      && /^(?:please\s+)?go\s+ahead[.!?]*$/i.test(questionLead(text))) return null;
    let last: Segment | undefined = this.parts[this.parts.length - 1];
    if (last && segment.timestamp_ms - last.timestamp_ms <= 10_000
        && questionIdentity(last.text) === questionIdentity(text)) return null;
    // Whisper can finalize a question before a caller finishes listing its
    // alternatives: "...only Google Ads?" / "Bing Ads as well as Meta.".
    // Revise the complete current question within that same remote turn.
    // Own speech, an acknowledgement or a newer statement breaks this lease.
    const extendsEmittedList = !!last && this.emittedParts > 0
      && this.parts.length === this.emittedParts && last.speaker === segment.speaker
      && segment.timestamp_ms - last.timestamp_ms >= 0
      && segment.timestamp_ms - last.timestamp_ms <= TURN_GAP_MS
      && isListContinuation(text);
    this.currentQuestion = null;
    // A caller may abandon "What is your ..." and insert their own background
    // story. That statement is not the grammatical completion of the question.
    if (last && isIncomplete(last.text) && !startsQuestion(text)
      && /^(?:it's been|it has been|i(?:'ve| have| am|'m| think| would)|we(?:'ve| have| are|'re))\b/i.test(questionLead(text))) {
      this.parts = [];
      this.context = '';
      this.emittedParts = 0;
      last = undefined;
    }
    // A fresh scenario can precede a short question ("Our campaign ... How
    // would you fix that?"). It must not inherit the previous answered topic.
    const newScenario = !startsQuestion(text)
      && /^(?:our|my|this|that|the|an?)\b/i.test(text)
      && text.split(/\s+/).length >= 6
      && !/\b(you've|you have|your|the|a|and|or|to|of|about|for example)[\s?.!,]*$/i.test(text);
    if (newScenario && (!last || this.parts.length === this.emittedParts)) {
      this.parts = [];
      this.context = '';
      this.emittedParts = 0;
      this.priorQuestion = null;
      last = undefined;
    }
    // Short pronoun-based questions belong to the preceding remote context.
    const refersBack = (/\b(that|those|this|it|your findings)\b/i.test(text)
      || /^(?:so\s+)?(?:what|how)\b.*\b(first|next|find|findings|results)[?.!]*$/i.test(text))
      && text.split(/\s+/).length <= 12;
    // A scenario can finish with a diagnostic question that has no pronoun:
    // "A customer gets the wrong reminder. How would you investigate?".
    // Preserve only an unsubmitted nearby scenario; an already emitted topic
    // must not be pulled into a new, otherwise context-free question.
    const completesPendingScenario = !!last && this.emittedParts === 0
      && segment.timestamp_ms - last.timestamp_ms <= TURN_GAP_MS
      && this.parts.some(p => !startsQuestion(p.text))
      && /^(?:(?:okay|alright|all right|so|and)[,\s]+)*(?:how|what)\s+(?:would|will|do|can|could|should)\s+you\s+(?:investigate|check|diagnose|test)(?:\s+(?:first|next))?[?.!]*$/i.test(text);
    const continuesIncompleteQuestion = !!last && this.emittedParts === 0
      && (this.parts.some(p => startsQuestion(p.text)) || startsQuestion(this.context))
      && isIncomplete(last.text) && !hasQuestionLead(text);
    if (!last || segment.timestamp_ms - last.timestamp_ms > TURN_GAP_MS
        || (startsQuestion(text) && !refersBack && !completesPendingScenario && !continuesIncompleteQuestion)) {
      this.parts = [];
      this.context = '';
      this.emittedParts = 0;
      last = undefined;
    }
    // If the speaker continues a just-emitted question, keep the previous
    // wording as context and let the newly completed phrase take priority.
    if (extendsEmittedList) {
      // Keep all wording even if the emitted question already used four STT
      // parts; adding this suffix must not evict its leading question clause.
      this.parts = [{ ...this.parts[0], text: this.parts.map(p => p.text).join(' ') }];
      this.emittedParts = 0;
    } else if (this.parts.length > 0 && this.parts.length === this.emittedParts) {
      this.context = this.parts.map(p => p.text).join(' ').slice(-800);
      this.parts = [];
      this.emittedParts = 0;
    }
    if (refersBack && this.parts.length === 0 && this.priorQuestion
        && segment.timestamp_ms - this.priorQuestion.timestamp_ms <= 180_000) {
      this.context = this.priorQuestion.text.slice(-800);
    }
    this.parts.push({ ...segment, text });
    this.parts = this.parts.slice(-4);
    const joined = this.parts.map(p => p.text).join(' ');
    const words = joined.split(/\s+/).length;
    // Hold obvious unfinished phrases, even when Whisper adds a question mark.
    if (isIncomplete(text)) return null;
    if (words < 3 || !(text.endsWith('?') || (startsQuestion(joined) && words >= 6))) return null;
    const question: RemoteQuestion = { text: this.context ? `Earlier question: ${this.context}\nCurrent question: ${joined}` : joined,
      timestamp_ms: segment.timestamp_ms, source: segment.speaker,
      confidence: 0.8, turnId: this.parts[0].id };
    this.priorQuestion = { ...question, text: joined };
    this.emittedParts = this.parts.length;
    this.currentQuestion = question;
    return question;
  }
}

/** Shared by manual Assist/Say and automatic detection; never use own speech. */
export function selectLatestRemoteQuestion(segments: RemoteSegment[], now: number): RemoteQuestion | null {
  const assembler = new RemoteQuestionAssembler();
  const unique = new Map(segments.map(segment => [segment.id, segment]));
  for (const segment of [...unique.values()].sort((a, b) => a.timestamp_ms - b.timestamp_ms)) {
    assembler.push(segment);
  }
  const question = assembler.getCurrentQuestion();
  return question && now - question.timestamp_ms <= 120_000 ? question : null;
}

export function resolveAssistanceQuestion(mode: string, customQuestion: string | undefined,
  segments: RemoteSegment[], now: number): string | undefined {
  if (customQuestion?.trim() || (mode !== 'Assist' && mode !== 'WhatToSay')) return customQuestion;
  const question = selectLatestRemoteQuestion(segments, now);
  if (!question) {
    throw new Error('No complete question from the other party yet. Wait for the question to finish, or type it in Ask.');
  }
  return question.text;
}
