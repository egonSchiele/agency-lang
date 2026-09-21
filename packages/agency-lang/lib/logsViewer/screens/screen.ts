import type { View } from "../views/view.js";
export type ScreenName = "overview" | "trace" | "transcript" | "timeline";
export const SCREEN_ORDER: ScreenName[] = ["overview", "trace", "transcript", "timeline"];
export type Screen = Omit<View, "viewName" | "escape"> & {
  screenName: ScreenName;
  focusId(): string | undefined;
  setFocus(id: string): void;
  setTrace(traceId: string): void;
  escape(): boolean;
  applySearch(query: string): void;
};
const SCREEN_KEYS = ["1", "2", "3", "4"];

export function screenForKey(key: string): ScreenName | undefined {
  const position = SCREEN_KEYS.indexOf(key);
  return position === -1 ? undefined : SCREEN_ORDER[position];
}
