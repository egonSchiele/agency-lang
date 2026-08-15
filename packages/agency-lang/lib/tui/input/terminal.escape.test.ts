import { describe, expect, it } from "vitest";

import { TerminalInput } from "./terminal.js";
import type { KeyEvent } from "./types.js";

const ESC = "\x1b";

/** Drive the private chunk parser the way the stream would. */
function feed(input: TerminalInput, chunks: string[]): KeyEvent[] {
  const seen: KeyEvent[] = [];
  const emit = (input as unknown as { emitKey(key: KeyEvent): void }).emitKey.bind(input);
  (input as unknown as { emitKey(key: KeyEvent): void }).emitKey = (key) => {
    seen.push(key);
  };
  for (const chunk of chunks) {
    (input as unknown as { parseAndEmit(text: string): void }).parseAndEmit(chunk);
  }
  (input as unknown as { emitKey(key: KeyEvent): void }).emitKey = emit;
  return seen;
}

describe("escape sequences split across chunks", () => {
  it("reassembles an arrow key split after the bracket", () => {
    expect(feed(new TerminalInput(), [`${ESC}[`, "A"])).toEqual([{ key: "up" }]);
  });

  it("reassembles a page key split before its terminator", () => {
    expect(feed(new TerminalInput(), [`${ESC}[5`, "~"])).toEqual([{ key: "pageup" }]);
  });

  it("reassembles a sequence split anywhere after the introducer", () => {
    for (const [sequence, key] of [
      [`${ESC}[C`, "right"],
      [`${ESC}[6~`, "pagedown"],
    ] as const) {
      for (let split = 2; split < sequence.length; split += 1) {
        const keys = feed(new TerminalInput(), [sequence.slice(0, split), sequence.slice(split)]);
        expect(keys).toEqual([{ key }]);
      }
    }
  });

  it("still emits a bare Escape immediately, since that is the Escape key", () => {
    expect(feed(new TerminalInput(), [ESC])).toEqual([{ key: "escape" }]);
  });

  it("KNOWN GAP: a chunk ending on the bare introducer is read as Escape", () => {
    // Holding a lone ESC would need a timer to tell the Escape key apart from
    // the first byte of a sequence, so this case is left as-is deliberately.
    // Terminals emit a sequence in one write, so a split here needs a 1-byte
    // buffer boundary — rare, and never silent, since the reader sees Escape.
    expect(feed(new TerminalInput(), [ESC, "[C"])[0]).toEqual({ key: "escape" });
  });

  it("emits ordinary characters without buffering", () => {
    expect(feed(new TerminalInput(), ["ab"])).toEqual([{ key: "a" }, { key: "b" }]);
  });
});

describe("suppressSigint", () => {
  it("emits ctrl-c as a key without raising SIGINT when asked", () => {
    const raised: string[] = [];
    const original = process.kill;
    (process as unknown as { kill: typeof process.kill }).kill = ((
      pid: number,
      signal?: string,
    ) => {
      raised.push(String(signal));
      return true;
    }) as typeof process.kill;
    try {
      const keys = feed(new TerminalInput({ suppressSigint: true }), ["\x03"]);
      expect(keys).toEqual([{ key: "c", ctrl: true }]);
      expect(raised).toEqual([]);
    } finally {
      (process as unknown as { kill: typeof process.kill }).kill = original;
    }
  });
});
