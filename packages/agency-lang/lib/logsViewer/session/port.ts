// What the running viewer lets a session request do. The shell builds one
// of these from its host and its comments source; the server calls it and
// nothing else. Requests name trace ids and row ids only, never screens or
// objects, so a viewer refactor cannot break the wire.
import type { ScreenName } from "../screens/screen.js";

export type Focus = {
  traceId: string;
  screen: ScreenName;
  /** Undefined on the trace picker, or on a row with no address. */
  rowId: string | undefined;
};

export type NavigateResult = "ok" | "no such trace" | "no such row" | "row hidden by filter";

export type SessionPort = {
  focus(): Focus;
  navigate(traceId: string, rowId: string | undefined): NavigateResult;
  /** Re-read the comments file and redraw; the CLI sends this after a write. */
  reloadComments(): void;
  notify(message: string): void;
};
