import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Frame } from "../frame.js";
import { TerminalOutput } from "../output/terminal.js";

const BEGIN_SYNC = "\x1b[?2026h";
const END_SYNC = "\x1b[?2026l";

function frameFromText(text: string): Frame {
  return new Frame({
    x: 0,
    y: 0,
    width: text.length,
    height: 1,
    style: {},
    content: [[...text].map((char) => ({ char }))],
  });
}

describe("TerminalOutput", () => {
  let writes: string[];
  let origWrite: typeof process.stdout.write;

  beforeEach(() => {
    writes = [];
    origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(() => {
    process.stdout.write = origWrite;
  });

  it("wraps frame writes in synchronized output markers", () => {
    const output = new TerminalOutput();
    output.write(frameFromText("abc"));
    output.destroy();

    const out = writes.join("");
    expect(out).toContain(`${BEGIN_SYNC}\x1b[Habc${END_SYNC}`);
  });

  it("only writes changed cells after the first frame", () => {
    const output = new TerminalOutput();
    output.write(frameFromText("abc"));
    writes.length = 0;

    output.write(frameFromText("axc"));
    output.destroy();

    const frameWrite = writes[0];
    expect(frameWrite).toContain(`${BEGIN_SYNC}\x1b[1;2Hx${END_SYNC}`);
    expect(frameWrite).not.toContain("axc");
  });

  it("can disable synchronized output while keeping diffed writes", () => {
    const output = new TerminalOutput({ synchronizedOutput: false });
    output.write(frameFromText("abc"));
    writes.length = 0;

    output.write(frameFromText("axc"));
    output.destroy();

    const frameWrite = writes[0];
    expect(frameWrite).toBe("\x1b[1;2Hx");
  });
});
