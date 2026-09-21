// The order in which Esc undoes things. One pure function, so the order is
// written once and tested without a terminal. Esc never quits.
import type { ScreenName } from "./screens/screen.js";

export type EscOutcome =
  "closeHelp" | "overlay" | "popOverlay" | "screen" | "goOverview" | "back" | "nothing";

export type EscState = {
  /** The terminal is under the minimum width, so nothing is drawn. */
  tooNarrow: boolean;
  helpOpen: boolean;
  overlayOpen: boolean;
  /** These two have a side effect: the overlay or screen undoes one thing
   *  and reports whether it had anything to undo. Each is called only on
   *  its own rung. */
  overlayEscaped: () => boolean;
  screenEscaped: () => boolean;
  activeScreen: ScreenName;
  embedded: boolean;
};

export function escOutcome(state: EscState): EscOutcome {
  const leave: EscOutcome = state.embedded ? "back" : "nothing";
  if (state.tooNarrow) {
    return leave;
  }
  if (state.helpOpen) {
    return "closeHelp";
  }
  if (state.overlayOpen) {
    return state.overlayEscaped() ? "overlay" : "popOverlay";
  }
  if (state.screenEscaped()) {
    return "screen";
  }
  if (state.activeScreen !== "overview") {
    return "goOverview";
  }
  return leave;
}
