// The viewer's screens and overlays, and the focus they share. No terminal
// in here: the shell draws whatever target() is and sends it keys.
import type { Screen, ScreenName } from "./screens/screen.js";
import type { TreeNode } from "./types.js";
import { makeViewStack, type View } from "./views/view.js";

export type HostScreens = Record<ScreenName, Screen>;

export class ScreenHost {
  private readonly overlays = makeViewStack();
  private active: ScreenName;
  private traceId: string;
  private help = false;
  private following = false;

  constructor(
    private readonly screens: HostScreens,
    initial: ScreenName,
    traceId: string,
  ) {
    this.active = initial;
    this.traceId = traceId;
  }

  activeScreen(): ScreenName {
    return this.active;
  }

  currentTraceId(): string {
    return this.traceId;
  }

  screen(name: ScreenName): Screen {
    return this.screens[name];
  }

  target(): View | Screen {
    return this.overlays.active() ?? this.screens[this.active];
  }

  overlayOpen(): boolean {
    return this.overlays.active() !== undefined;
  }

  helpOpen(): boolean {
    return this.help;
  }

  toggleHelp(): void {
    this.help = !this.help;
  }

  closeHelp(): void {
    this.help = false;
  }

  /** The shared cursor: what was focused where we were is focused where
   *  we are going. */
  switchTo(name: ScreenName, focusId?: string): void {
    const carried = focusId ?? this.screens[this.active].focusId();
    this.closeAllOverlays();
    this.active = name;
    if (carried !== undefined) {
      this.screens[name].setFocus(carried);
    }
  }

  openOverlay(view: View): void {
    view.setFollowIndicator(this.following);
    this.overlays.push(view);
  }

  closeOverlay(): void {
    this.overlays.pop();
  }

  selectTrace(traceId: string, query?: string): void {
    this.closeAllOverlays();
    this.showTrace(traceId);
    if (query !== undefined && query.length > 0) {
      // The trace searches payloads and is available from PR 4 onward.
      this.active = "trace";
      this.screens.trace.applySearch(query);
    }
  }

  stepTrace(delta: 1 | -1, traceIds: string[]): void {
    if (traceIds.length < 2) {
      return;
    }
    const position = Math.max(0, traceIds.indexOf(this.traceId));
    const next = (position + delta + traceIds.length) % traceIds.length;
    this.showTrace(traceIds[next]);
  }

  setData(roots: TreeNode[], fallbackTraceId: string): void {
    this.everyView().forEach((view) => view.setData(roots));
    const stillThere = roots.some((root) => root.traceId === this.traceId);
    if (!stillThere) {
      this.showTrace(fallbackTraceId);
    }
  }

  setFollowIndicator(on: boolean): void {
    this.following = on;
    this.everyView().forEach((view) => view.setFollowIndicator(on));
  }

  escapeOverlay(): boolean {
    return this.overlays.active()?.escape?.() ?? false;
  }

  escapeScreen(): boolean {
    return this.screens[this.active].escape();
  }

  private showTrace(traceId: string): void {
    this.traceId = traceId;
    Object.values(this.screens).forEach((screen) => screen.setTrace(traceId));
  }

  private closeAllOverlays(): void {
    this.overlays.all().forEach(() => this.overlays.pop());
  }

  private everyView(): (View | Screen)[] {
    return [...Object.values(this.screens), ...this.overlays.all()];
  }
}
