import { Keyboard, TextInput } from 'react-native';

let covered = false;
const subscribers = new Set<() => void>();

export function isCovered(): boolean {
  return covered;
}
export function subscribeCovered(listener: () => void): () => void {
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
  };
}
export function setCovered(next: boolean): void {
  if (covered === next) return;
  covered = next;
  if (next) {
    try {
      Keyboard.dismiss?.();
    } catch {
      /* Cover must still notify. */
    }
    try {
      const input = TextInput.State.currentlyFocusedInput?.();
      if (input) TextInput.State.blurTextInput?.(input);
    } catch {
      /* Cover must still notify. */
    }
  }
  [...subscribers].forEach((listener) => listener());
}
export function resetCoverForTests(): void {
  covered = false;
  subscribers.clear();
}
