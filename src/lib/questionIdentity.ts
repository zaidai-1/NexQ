/** Ignore punctuation/case changes from duplicate final STT events. */
export function questionIdentity(text: string): string {
  return text.toLocaleLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();
}

export class AutomaticQuestionGate {
  private recent = new Map<string, number>();

  claim(text: string, now: number): boolean {
    const key = questionIdentity(text);
    if (!key) return false;
    for (const [oldKey, timestamp] of this.recent) {
      if (now - timestamp >= 10_000) this.recent.delete(oldKey);
    }
    if (this.recent.has(key)) return false;
    this.recent.set(key, now);
    return true;
  }
}
