import type { Frame } from "../frame.js";
import type { OutputTarget } from "./types.js";
import { toANSI } from "../render/ansi.js";

const ENTER_ALT_SCREEN = "\x1b[?1049h";
const EXIT_ALT_SCREEN = "\x1b[?1049l";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CURSOR_HOME = "\x1b[H";
// Synchronized output (BSU/ESU, DCS 2026): tells supporting
// terminals to buffer drawing operations between BSU and ESU and
// apply them atomically. Eliminates the cell-by-cell repaint flicker
// otherwise visible during a full-screen render. Terminals without
// support (older xterm etc.) silently ignore the sequences.
// Spec: https://gist.github.com/christianparpart/d8a62cc1ab659194337d73e399004036
const BEGIN_SYNC = "\x1b[?2026h";
const END_SYNC = "\x1b[?2026l";

export class TerminalOutput implements OutputTarget {
  private inAltScreen = false;
  // Cache of the last rendered frame ANSI so we can skip the write
  // entirely when a tick re-renders unchanged content. Without this,
  // a tickMs of 100 redraws the full screen 10x/sec — visible as
  // flicker on slower terminals even though every redraw is identical.
  private lastAnsi: string | null = null;
  // Tracks whether our SIGTSTP listener is currently installed. We
  // remove it during the suspend handoff and re-install it on resume,
  // and SIGCONT can be delivered independently of our SIGTSTP path
  // (e.g. from a foreign SIGSTOP), so the resume path must be idempotent.
  private sigtstpInstalled = false;
  private exitHandler = () => this.destroy();
  private sigintHandler = () => { this.destroy(); process.exit(130); };
  private sigtermHandler = () => { this.destroy(); process.exit(143); };
  private sigtstpHandler = () => {
    // Remove our handler before re-raising so the default handler can
    // actually suspend the process; otherwise we'd recurse into ourselves.
    this.suspend();
    if (this.sigtstpInstalled) {
      process.removeListener("SIGTSTP", this.sigtstpHandler);
      this.sigtstpInstalled = false;
    }
    process.kill(process.pid, "SIGTSTP");
  };
  private sigcontHandler = () => {
    this.resume();
    // Re-install only if we don't currently have it registered.
    if (!this.sigtstpInstalled) {
      process.on("SIGTSTP", this.sigtstpHandler);
      this.sigtstpInstalled = true;
    }
  };

  init(): void {
    process.stdout.write(ENTER_ALT_SCREEN + HIDE_CURSOR);
    this.inAltScreen = true;
    process.on("exit", this.exitHandler);
    process.on("SIGINT", this.sigintHandler);
    process.on("SIGTERM", this.sigtermHandler);
    process.on("SIGTSTP", this.sigtstpHandler);
    this.sigtstpInstalled = true;
    process.on("SIGCONT", this.sigcontHandler);
  }

  write(frame: Frame, _label?: string): void {
    if (!this.inAltScreen) {
      this.init();
    }
    const ansi = toANSI(frame);
    // Skip identical re-paints. Repaints that produce the same ANSI
    // (the common case under tickMs: e.g. status bar shows the same
    // cost every tick) get dropped here, eliminating flicker without
    // changing render semantics. `lastAnsi` is invalidated on
    // suspend/resume so the next frame redraws unconditionally.
    if (ansi === this.lastAnsi) return;
    this.lastAnsi = ansi;
    // Wrap the full-frame write in BSU/ESU so supporting terminals
    // apply the new frame atomically instead of streaming the
    // repaint cell-by-cell (which the eye perceives as flicker).
    process.stdout.write(BEGIN_SYNC + CURSOR_HOME + ansi + END_SYNC);
  }

  destroy(): void {
    if (this.inAltScreen) {
      process.stdout.write(SHOW_CURSOR + EXIT_ALT_SCREEN);
      this.inAltScreen = false;
    }
    this.lastAnsi = null;
    this.removeSignalHandlers();
  }

  suspend(): void {
    if (this.inAltScreen) {
      process.stdout.write(SHOW_CURSOR + EXIT_ALT_SCREEN);
      this.inAltScreen = false;
    }
    this.lastAnsi = null;
  }

  resume(): void {
    if (!this.inAltScreen) {
      process.stdout.write(ENTER_ALT_SCREEN + HIDE_CURSOR);
      this.inAltScreen = true;
    }
    this.lastAnsi = null;
  }

  private removeSignalHandlers(): void {
    process.removeListener("exit", this.exitHandler);
    process.removeListener("SIGINT", this.sigintHandler);
    process.removeListener("SIGTERM", this.sigtermHandler);
    process.removeListener("SIGTSTP", this.sigtstpHandler);
    process.removeListener("SIGCONT", this.sigcontHandler);
    this.sigtstpInstalled = false;
  }
}
