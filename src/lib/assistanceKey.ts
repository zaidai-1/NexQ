/** Accessibility/Unicode input may supply a key without a physical code. */
export function assistanceKeyCode(code: string, key: string): string {
  if (code && code !== 'Unidentified') return code;
  if (key === ' ') return 'Space';
  return /^[1-5]$/.test(key) ? `Digit${key}` : code;
}
