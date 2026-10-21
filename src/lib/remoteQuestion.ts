import { questionIdentity } from './questionIdentity.ts';

type Segment = { id: string; text: string; speaker: string; timestamp_ms: number; is_final: boolean };
export type RemoteQuestion = { text: string; timestamp_ms: number; source: 'Them' | 'Interviewer'; confidence: number; turnId: string };

function startsQuestion(text: string): boolean {
  return /^(?:(?:okay|alright|all right|so|and)[,\s]+)*(?:what|how|why|when|where|who|which|can you|could you|would you|do you|are you|is there|have you|tell me|explain|describe|walk me)\b/i.test(text);
}

/** Assemble final remote STT segments; never split one turn into sentence questions. */
export class RemoteQuestionAssembler {
  private parts: Segment[] = [];
  private priorQuestion: RemoteQuestion | null = null;
  private context = '';
  private emittedParts = 0;

  push(segment: Segment): RemoteQuestion | null {
    if (!segment.is_final) return null;
    if (segment.speaker !== 'Them' && segment.speaker !== 'Interviewer') {
      this.parts = [];
      this.context = '';
      this.emittedParts = 0;
      return null;
    }
    const text = segment.text.trim();
    if (!text) return null;
    let last: Segment | undefined = this.parts[this.parts.length - 1];
    if (last && segment.timestamp_ms - last.timestamp_ms <= 10_000
        && questionIdentity(last.text) === questionIdentity(text)) return null;
    // Short pronoun-based questions belong to the preceding remote context.
    const refersBack = (/\b(that|those|this|it|your findings)\b/i.test(text)
      || /^(?:so\s+)?(?:what|how)\b.*\b(first|next|find|findings|results)[?.!]*$/i.test(text))
      && text.split(/\s+/).length <= 12;
    if (!last || segment.timestamp_ms - last.timestamp_ms > 10_000
        || (startsQuestion(text) && !refersBack)) {
      this.parts = [];
      this.context = '';
      this.emittedParts = 0;
      last = undefined;
    }
    // If the speaker continues a just-emitted question, keep the previous
    // wording as context and let the newly completed phrase take priority.
    if (this.parts.length > 0 && this.parts.length === this.emittedParts) {
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
    if (/\b(you've|you have|your|the|a|and|or|to|of|about|what were your|for example)[\s?.!,]*$/i.test(text)) return null;
    if (words < 4 || !(text.endsWith('?') || (startsQuestion(joined) && words >= 6))) return null;
    const question: RemoteQuestion = { text: this.context ? `Earlier question: ${this.context}\nCurrent question: ${joined}` : joined,
      timestamp_ms: segment.timestamp_ms, source: segment.speaker,
      confidence: 0.8, turnId: this.parts[0].id };
    this.priorQuestion = { ...question, text: joined };
    this.emittedParts = this.parts.length;
    return question;
  }
}
