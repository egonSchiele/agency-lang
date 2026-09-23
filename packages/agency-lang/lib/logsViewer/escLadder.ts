// Esc clears the nearest active state before returning to the host.
import type { ScreenName } from "./screens/screen.js";

export type EscOutcome =
  | "closeHelp"
  | "overlay"
  | "popOverlay"
  | "screen"
  | "goOverview"
  | "goTraces"
  | "back"
  | "nothing";

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
  tracePickerOpen: boolean;
  tracePickerAvailable: boolean;
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
    if (state.overlayEscaped()) {
      return "overlay";
    }
    return state.tracePickerOpen ? leave : "popOverlay";
  }
  if (state.screenEscaped()) {
    return "screen";
  }
  if (state.activeScreen !== "overview") {
    return "goOverview";
  }
  if (state.tracePickerAvailable) {
    return "goTraces";
  }
  return leave;
}
