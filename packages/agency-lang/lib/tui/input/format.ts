import type { KeyEvent } from "./types.js";

const TITLE_CASED: Record<string, string> = {
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  enter: "Enter",
  escape: "Escape",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  insert: "Insert",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  space: "Space",
};

// Canonical string for a KeyEvent — single chars verbatim ("j", "G"),
// named keys title-cased ("Up", "PageDown"), with "Ctrl+" / "Shift+"
// prefixes in a stable order. Letter keys after Ctrl+ are uppercased
// so "Ctrl+C" matches what most docs and bindings use.
export function formatKey(event: KeyEvent): string {
  const base = TITLE_CASED[event.key] ?? event.key;
  const body =
    event.ctrl && base.length === 1 ? base.toUpperCase() : base;
  const parts: string[] = [];
  if (event.ctrl) parts.push("Ctrl");
  if (event.shift) parts.push("Shift");
  parts.push(body);
  return parts.join("+");
}

// Case-insensitive predicate. Accepts any spelling formatKey could
// produce (e.g. "ctrl+c", "Ctrl+C", "CTRL+C" all match).
export function keyMatches(event: KeyEvent, name: string): boolean {
  return formatKey(event).toLowerCase() === name.toLowerCase();
}
