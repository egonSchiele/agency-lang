import { runKey, type KeyBinding } from "../tui/keymap.js";
import type { ViewAction } from "./views/view.js";
export { cursorBindings, helpFrom, hintsFrom, findBinding, duplicateKeys } from "../tui/keymap.js";
export type ViewerBinding = KeyBinding<ViewAction>;
export function runViewerKey(bindings: ViewerBinding[], key: string): ViewAction {
  return runKey(bindings, key, { kind: "none" });
}
