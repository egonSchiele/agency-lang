import { describe, expect, it } from "vitest";
import * as readline from "node:readline";
import { PassThrough } from "node:stream";
import { _internal, _setSlashPalette, _slashPalette } from "./cli.js";

type Key = { name?: string; sequence?: string };

/** A stand-in for readline's line editing: printable keys go into `line`,
 *  and Enter is recorded in `submitted`. */
function fakeReadline() {
  const fake = {
    line: "",
    cursor: 0,
    submitted: [] as string[],
    _ttyWrite(s: string, key: Key): void {
      if (key.name === "return") {
        fake.submitted.push(fake.line);
        fake.line = "";
        return;
      }
      fake.line += s;
    },
  };
  return fake;
}

/** Send each character of `text` as one key, all in the same tick, the way
 *  readline delivers a chunk of pasted text. */
function sendKeys(rl: { _ttyWrite(s: string, key: Key): void }, text: string): void {
  for (const ch of text) {
    rl._ttyWrite(ch, { sequence: ch, name: ch === "/" ? undefined : ch });
  }
}

const nextTick = () => new Promise((r) => setImmediate(r));

describe("askLine", () => {
  it("opens with the prefill and the cursor at its end", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const rl = readline.createInterface({ input, output, terminal: true });
    const answer = _internal.askLine(rl, "> ", "/rename ");
    const state = rl as unknown as { line: string; cursor: number };
    expect(state.line).toBe("/rename ");
    expect(state.cursor).toBe(8);
    input.write("title\r");
    expect(await answer).toBe("/rename title");
    rl.close();
  });
});

describe("installSlashTrigger", () => {
  const palette: [string, string][] = [["/rename", "Rename"]];

  it("submits a lone / so the palette opens", async () => {
    const rl = fakeReadline();
    let triggered = 0;
    _internal.installSlashTrigger(rl as unknown as readline.Interface, palette, true, () => {
      triggered++;
    });
    sendKeys(rl, "/");
    await nextTick();
    expect(rl.submitted).toEqual(["/"]);
    expect(triggered).toBe(1);
  });

  it("leaves a pasted command with arguments at the prompt", async () => {
    const rl = fakeReadline();
    let triggered = 0;
    _internal.installSlashTrigger(rl as unknown as readline.Interface, palette, true, () => {
      triggered++;
    });
    sendKeys(rl, "/review-pr https://example.com/pull/1");
    await nextTick();
    expect(rl.submitted).toEqual([]);
    expect(rl.line).toBe("/review-pr https://example.com/pull/1");
    expect(triggered).toBe(0);
  });

  it("types a / that does not start the line", async () => {
    const rl = fakeReadline();
    _internal.installSlashTrigger(rl as unknown as readline.Interface, palette, true, () => {});
    sendKeys(rl, "a/b");
    await nextTick();
    expect(rl.submitted).toEqual([]);
    expect(rl.line).toBe("a/b");
  });
});

describe("_slashPalette", () => {
  it("uses the registered palette when repl() passed none", () => {
    _setSlashPalette({ "/rename": "Rename", cost: "not a slash command" });
    expect(_slashPalette(null)).toEqual([["/rename", "Rename"]]);
  });

  it("prefers the palette passed to repl()", () => {
    _setSlashPalette({ "/rename": "Rename" });
    expect(_slashPalette({ "/cost": "Cost" })).toEqual([["/cost", "Cost"]]);
  });
});
