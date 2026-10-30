type CardKeyEvent = {
  key: string;
  preventDefault(): void;
  stopPropagation(): void;
};

/** Enter explicitly selects a card. Space belongs to the current-question shortcut. */
export function handleQuestionCardKey(event: CardKeyEvent, selectCard: () => void) {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  event.stopPropagation();
  selectCard();
}
