type CardKeyEvent = {
  key: string;
  target?: unknown;
  currentTarget?: unknown;
  preventDefault(): void;
  stopPropagation(): void;
};

/** Enter explicitly selects a card. Space belongs to the current-question shortcut. */
export function handleQuestionCardKey(event: CardKeyEvent, selectCard: () => void) {
  if (event.key !== 'Enter' || event.target !== event.currentTarget) return;
  event.preventDefault();
  event.stopPropagation();
  selectCard();
}
