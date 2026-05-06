import * as readline from "node:readline";
import type { KeyEvent, InputSource } from "./types.js";

// Map ANSI escape sequences to key names
const ESC_MAP: Record<string, KeyEvent> = {
  "\x1b[A": { key: "up" },
  "\x1b[B": { key: "down" },
  "\x1b[C": { key: "right" },
  "\x1b[D": { key: "left" },
  "\x1b[H": { key: "home" },
  "\x1b[F": { key: "end" },
  "\x1b[5~": { key: "pageup" },
  "\x1b[6~": { key: "pagedown" },
  "\x1b[3~": { key: "delete" },
  "\x1b[2~": { key: "insert" },
  "\x1bOA": { key: "up" },
  "\x1bOB": { key: "down" },
  "\x1bOC": { key: "right" },
  "\x1bOD": { key: "left" },
  "\x1bOH": { key: "home" },
  "\x1bOF": { key: "end" },
  // Shift+arrow
  "\x1b[1;2A": { key: "up", shift: true },
  "\x1b[1;2B": { key: "down", shift: true },
  "\x1b[1;2C": { key: "right", shift: true },
  "\x1b[1;2D": { key: "left", shift: true },
};

function parseKeypress(data: string): KeyEvent {
  // Check escape sequence map
  const mapped = ESC_MAP[data];
  if (mapped) return mapped;

  // Single escape
  if (data === "\x1b") return { key: "escape" };

  // Ctrl+letter (0x01-0x1a)
  const code = data.charCodeAt(0);
  if (data.length === 1 && code >= 1 && code <= 26) {
    const letter = String.fromCharCode(code + 96); // 1 -> 'a', 3 -> 'c', etc.
    return { key: letter, ctrl: true };
  }

  // Enter
  if (data === "\r" || data === "\n") return { key: "enter" };

  // Backspace
  if (data === "\x7f") return { key: "backspace" };

  // Tab
  if (data === "\t") return { key: "tab" };

  // Regular character
  return { key: data };
}

export class TerminalInput implements InputSource {
  private keyWaiters: ((key: KeyEvent) => void)[] = [];
  private keyQueue: KeyEvent[] = [];
  private dataHandler: ((data: Buffer) => void) | null = null;
  private wasRaw = false;
  private initialized = false;

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
      const key = parseKeypress(str);
      const waiter = this.keyWaiters.shift();
      if (waiter) {
        waiter(key);
      } else {
        this.keyQueue.push(key);
      }
    };

    process.stdin.on("data", this.dataHandler);
  }

  nextKey(): Promise<KeyEvent> {
    this.ensureInitialized();
    const queued = this.keyQueue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => {
      this.keyWaiters.push(resolve);
    });
  }

  nextLine(prompt: string): Promise<string> {
    // Temporarily exit raw mode for line input
    if (process.stdin.isTTY && process.stdin.isRaw) {
      process.stdin.setRawMode(false);
    }
    if (this.dataHandler) {
      process.stdin.removeListener("data", this.dataHandler);
    }

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    return new Promise<string>((resolve) => {
      rl.question(prompt, (answer) => {
        rl.close();
        // Re-enter raw mode
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
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(this.wasRaw);
    }
    process.stdin.pause();
  }
}
