import { questionIdentity } from './questionIdentity.ts';

type Segment = { id: string; text: string; speaker: string; timestamp_ms: number; is_final: boolean };
export type RemoteQuestion = { text: string; timestamp_ms: number; source: 'Them' | 'Interviewer'; confidence: number; turnId: string };

function startsQuestion(text: string): boolean {
  return /^(?:(?:okay|alright|all right|so|and)[,\s]+)*(?:what|how|why|when|where|who|which|can you|could you|would you|do you|are you|is there|have you|tell me|explain|describe|walk me)\b/i.test(text);
}

/** Assemble final remote STT segments; never split one turn into sentence questions. */
export class RemoteQuestionAssembler {
  private parts: Segment[] = [];

  push(segment: Segment): RemoteQuestion | null {
    if (!segment.is_final) return null;
    if (segment.speaker !== 'Them' && segment.speaker !== 'Interviewer') {
      this.parts = [];
      return null;
    }
    const text = segment.text.trim();
    if (!text) return null;
    let last: Segment | undefined = this.parts[this.parts.length - 1];
    if (last && segment.timestamp_ms - last.timestamp_ms <= 10_000
        && questionIdentity(last.text) === questionIdentity(text)) return null;
    // Short pronoun-based questions belong to the preceding remote context.
    const refersBack = (/\b(that|those|this|it|your findings)\b/i.test(text)
      || /^(?:so\s+)?(?:what|how)\b.*\b(first|next|findings|results)[?.!]*$/i.test(text))
      && text.split(/\s+/).length <= 12;
    if (!last || segment.timestamp_ms - last.timestamp_ms > 10_000
        || (startsQuestion(text) && !refersBack)) {
      this.parts = [];
      last = undefined;
    }
    this.parts.push({ ...segment, text });
    this.parts = this.parts.slice(-4);
    const joined = this.parts.map(p => p.text).join(' ');
    const words = joined.split(/\s+/).length;
    // Hold obvious unfinished phrases, even when Whisper adds a question mark.
    if (/\b(you've|you have|your|the|a|and|or|to|of|about|what were your|for example)[\s?.!,]*$/i.test(text)) return null;
    if (words < 4 || !(text.endsWith('?') || (startsQuestion(joined) && words >= 6))) return null;
    return { text: joined, timestamp_ms: segment.timestamp_ms, source: segment.speaker,
      confidence: 0.8, turnId: this.parts[0].id };
  }
}
