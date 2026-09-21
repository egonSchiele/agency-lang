import { column } from "../../tui/builders.js";
import { paint, paintedLine } from "../../tui/paint.js";
import type { Element } from "../../tui/elements.js";
import type { TreeNode } from "../types.js";
import type { ViewAction } from "../views/view.js";
import type { Screen, ScreenName } from "./screen.js";
export class PlaceholderScreen implements Screen {
  private focus: string | undefined;
  private message = "";
  constructor(
    readonly screenName: ScreenName,
    private readonly sentence: string,
  ) {}
  handleKey(): ViewAction {
    return { kind: "none" };
  }
  render(): Element {
    return column(
      { justifyContent: "flex-start" },
      paintedLine(paint(this.sentence)),
      paintedLine(paint(this.message)),
    );
  }
  setData(_roots: TreeNode[]): void {}
  setTrace(_traceId: string): void {
    this.focus = undefined;
  }
  setFollowIndicator(_on: boolean): void {}
  focusId(): string | undefined {
    return this.focus;
  }
  setFocus(id: string): void {
    this.focus = id;
  }
  escape(): boolean {
    return false;
  }
  applySearch(_query: string): void {}
  helpLines(): string[] {
    return [];
  }
  notify(message: string): void {
    this.message = message;
  }
}
