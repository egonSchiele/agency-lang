import * as readline from "node:readline";
import type { KeyEvent, InputSource } from "./types.js";

const KEY_MAP: Record<string, KeyEvent> = {
  // Special keys
  "\x1b": { key: "escape" },
  "\r": { key: "enter" },
  "\n": { key: "enter" },
  "\x7f": { key: "backspace" },
  "\t": { key: "tab" },
  // Arrow keys (CSI)
  "\x1b[A": { key: "up" },
  "\x1b[B": { key: "down" },
  "\x1b[C": { key: "right" },
  "\x1b[D": { key: "left" },
  // Arrow keys (SS3)
  "\x1bOA": { key: "up" },
  "\x1bOB": { key: "down" },
  "\x1bOC": { key: "right" },
  "\x1bOD": { key: "left" },
  // Navigation
  "\x1b[H": { key: "home" },
  "\x1b[F": { key: "end" },
  "\x1bOH": { key: "home" },
  "\x1bOF": { key: "end" },
  "\x1b[5~": { key: "pageup" },
  "\x1b[6~": { key: "pagedown" },
  "\x1b[3~": { key: "delete" },
  "\x1b[2~": { key: "insert" },
  // Shift+arrow
  "\x1b[1;2A": { key: "up", shift: true },
  "\x1b[1;2B": { key: "down", shift: true },
  "\x1b[1;2C": { key: "right", shift: true },
  "\x1b[1;2D": { key: "left", shift: true },
  // Shift+Tab (CSI Z) — used for reverse focus cycling
  "\x1b[Z": { key: "tab", shift: true },
};

// Sentinel used to wake up nextKey() waiters with a rejection when the
// terminal is being handed over to readline for nextLine().
const LINE_MODE_CANCEL: KeyEvent = { key: "__line_mode_cancel__" };

function parseKeypress(data: string): KeyEvent {
  const mapped = KEY_MAP[data];
  if (mapped) return mapped;

  // Ctrl+letter (0x01-0x1a)
  const code = data.charCodeAt(0);
  if (data.length === 1 && code >= 1 && code <= 26) {
    return { key: String.fromCharCode(code + 96), ctrl: true };
  }

  return { key: data };
}

export class TerminalInput implements InputSource {
  private keyWaiters: ((key: KeyEvent) => void)[] = [];
  private keyQueue: KeyEvent[] = [];
  private dataHandler: ((data: Buffer) => void) | null = null;
  private sigcontHandler: (() => void) | null = null;
  private wasRaw = false;
  private initialized = false;
  private inLineMode = false;
  private suspended = false;

  private ensureInitialized(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.init();
  }

  init(): void {
    if (!process.stdin.isTTY) {
      throw new Error("TerminalInput requires a TTY stdin");
    }

    this.wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();

    this.dataHandler = (data: Buffer) => {
      const str = data.toString("utf-8");
      // In raw mode the TTY does not translate Ctrl+Z (0x1a) into SIGTSTP;
      // the byte is delivered to us. Trigger suspend manually so the user's
      // expectation of "Ctrl+Z suspends" still works.
      if (str.length === 1 && str.charCodeAt(0) === 0x1a) {
        this.handleSuspendKeypress();
        return;
      }
      const key = parseKeypress(str);
      const waiter = this.keyWaiters.shift();
      if (waiter) {
        waiter(key);
      } else {
        this.keyQueue.push(key);
      }
    };

    process.stdin.on("data", this.dataHandler);

    // SIGCONT can be delivered after our Ctrl+Z handoff or after a foreign
    // SIGSTOP; either way we need to put stdin back into raw mode.
    this.sigcontHandler = () => this.resumeFromSuspend();
    process.on("SIGCONT", this.sigcontHandler);
  }

  // Called when 0x1a arrives in raw mode. Suspend our own stdin handling,
  // then re-raise SIGTSTP to the process so the OS (and TerminalOutput's
  // SIGTSTP handler) can suspend us cleanly.
  private handleSuspendKeypress(): void {
    this.suspendForSigtstp();
    process.kill(process.pid, "SIGTSTP");
  }

  private suspendForSigtstp(): void {
    if (this.suspended) return;
    this.suspended = true;
    if (this.dataHandler) {
      process.stdin.removeListener("data", this.dataHandler);
    }
    if (process.stdin.isTTY && process.stdin.isRaw) {
      process.stdin.setRawMode(false);
    }
  }

  private resumeFromSuspend(): void {
    if (!this.suspended) return;
    this.suspended = false;
    if (this.inLineMode) return; // readline owns stdin; don't re-grab it
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
    }
    if (this.dataHandler) {
      process.stdin.on("data", this.dataHandler);
    }
  }

  nextKey(): Promise<KeyEvent> {
    this.ensureInitialized();
    const queued = this.keyQueue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      this.keyWaiters.push((key) => {
        if (key === LINE_MODE_CANCEL) {
          reject(new Error("nextKey() cancelled by nextLine()"));
        } else {
          resolve(key);
        }
      });
    });
  }

  nextLine(prompt: string): Promise<string> {
    if (this.inLineMode) {
      return Promise.reject(new Error("nextLine() already in progress"));
    }
    this.inLineMode = true;
    // Cancel any pending nextKey() waiters: readline is about to take over
    // stdin, so they will never receive a keypress through our data handler.
    for (const waiter of this.keyWaiters) {
      waiter(LINE_MODE_CANCEL);
    }
    this.keyWaiters = [];
    if (process.stdin.isTTY && process.stdin.isRaw) {
      process.stdin.setRawMode(false);
    }
    if (this.dataHandler) {
      process.stdin.removeListener("data", this.dataHandler);
    }

    // Created per-call because readline takes ownership of stdin and
    // must be closed before we can re-enter raw mode for key input.
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    return new Promise<string>((resolve) => {
      rl.question(prompt, (answer) => {
        rl.close();
        this.inLineMode = false;
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(true);
          process.stdin.resume();
        }
        if (this.dataHandler) {
          process.stdin.on("data", this.dataHandler);
        }
        resolve(answer);
      });
    });
  }

  destroy(): void {
    if (this.dataHandler) {
      process.stdin.removeListener("data", this.dataHandler);
      this.dataHandler = null;
    }
    if (this.sigcontHandler) {
      process.removeListener("SIGCONT", this.sigcontHandler);
      this.sigcontHandler = null;
    }
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(this.wasRaw);
    }
    process.stdin.pause();
    this.keyQueue = [];
    this.keyWaiters = [];
    this.suspended = false;
    this.initialized = false;
  }
}
