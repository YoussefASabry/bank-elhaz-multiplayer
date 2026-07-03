export function rollDice() {
  const die1 = Math.floor(Math.random() * 6) + 1;
  const die2 = Math.floor(Math.random() * 6) + 1;
  return { die1, die2, total: die1 + die2, isDouble: die1 === die2 };
}

export function calculateNewPosition(currentPosition, steps) {
  return ((currentPosition - 1 + steps) % 34 + 34) % 34 + 1;
}

export function didPassGo(oldPos, newPos) {
  return newPos < oldPos;
}
