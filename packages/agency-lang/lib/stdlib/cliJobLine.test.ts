import { describe, it, expect } from "vitest";
import * as readline from "readline";
import { PassThrough, Writable } from "stream";
import { jobEndLines, jobEndedLine } from "./cliJobLine.js";
import type { JobSummary } from "../runtime/jobs/jobTable.js";

const COLUMNS = 60;

const job: JobSummary = {
  id: "job-3fa9c1",
  command: "./x.sh",
  state: "ended",
  exitCode: 0,
  startedAt: 1000,
  endedAt: 1000 + 41 * 60_000 + 8000,
  unread: true,
};

/** A terminal screen, for the escape sequences readline and the finish
 *  line write: cursor up and down, column, clear down, clear line, and
 *  wrapping at the right edge. Returns the rows as text. */
function screenOf(data: string): string[] {
  const rows: string[][] = [[]];
  let row = 0;
  let col = 0;
  const reach = () => {
    while (rows.length <= row) rows.push([]);
  };
  for (let i = 0; i < data.length; i++) {
    const escape = /^\x1b\[(\d*)([A-Za-z])/.exec(data.slice(i));
    if (escape) {
      const n = escape[1] === "" ? 1 : Number(escape[1]);
      const code = escape[2];
      if (code === "A") row = Math.max(0, row - n);
      if (code === "B") row += n;
      if (code === "C") col += n;
      if (code === "D") col = Math.max(0, col - n);
      if (code === "G") col = n - 1;
      if (code === "J") {
        reach();
        rows[row].length = Math.min(rows[row].length, col);
        rows.length = row + 1;
      }
      if (code === "K") {
        reach();
        rows[row] = [];
      }
      reach();
      i += escape[0].length - 1;
      continue;
    }
    const ch = data[i];
    if (ch === "\r") {
      col = 0;
    } else if (ch === "\n") {
      row++;
      col = 0;
      reach();
    } else {
      if (col >= COLUMNS) {
        row++;
        col = 0;
      }
      reach();
      rows[row][col] = ch;
      col++;
    }
  }
  return rows.map((cells) =>
    Array.from(cells, (cell) => cell ?? " ")
      .join("")
      .trimEnd(),
  );
}

/** A real readline prompt on a narrow terminal, with `typed` typed. With
 *  `drawn` false, nothing is on the screen yet. */
function promptWith(typed: string, drawn = true) {
  let written = "";
  const out = Object.assign(
    new Writable({
      write(chunk, _encoding, done) {
        written += chunk.toString();
        done();
      },
    }),
    { columns: COLUMNS, rows: 24, isTTY: true },
  );
  const rl = readline.createInterface({
    input: new PassThrough(),
    output: out,
    terminal: true,
    prompt: "> ",
  });
  if (drawn) {
    rl.prompt();
    rl.write(typed);
  }
  return { rl, out, screen: () => screenOf(written) };
}

describe("jobEndedLine", () => {
  it("names the job, how long it ran, how it ended, and the command", () => {
    expect(jobEndedLine(job)).toBe("job-3fa9c1 finished after 41m 8s (exit 0): ./x.sh");
  });

  it("says when a job was stopped or timed out", () => {
    expect(jobEndedLine({ ...job, state: "stopped", exitCode: null })).toContain("(stopped)");
    expect(jobEndedLine({ ...job, state: "timedOut", exitCode: null })).toContain("(timed out)");
  });
});

describe("jobEndLines", () => {
  const terminal = { useTTY: true, useColor: false };
  const line = jobEndedLine(job);

  it("puts the line above a prompt and keeps what was typed", () => {
    const { rl, out, screen } = promptWith("hello");
    const lines = jobEndLines(rl, out, terminal);
    lines.setOwner("prompt");
    lines.jobEnded(job);
    expect(screen()).toEqual([line, "> hello"]);
    rl.close();
  });

  it("clears every row of typed text that wraps, and leaves no fragment", () => {
    const { rl, out, screen } = promptWith("x".repeat(90));
    const lines = jobEndLines(rl, out, terminal);
    lines.setOwner("prompt");
    lines.jobEnded(job);
    expect(screen()).toEqual([line, `> ${"x".repeat(58)}`, "x".repeat(32)]);
    rl.close();
  });

  it("holds the line while something else owns the terminal, and prints it before the next prompt", () => {
    // The slash menu or `/paste` owns the screen, so nothing is written.
    const { rl, out, screen } = promptWith("", false);
    const lines = jobEndLines(rl, out, terminal);
    lines.setOwner("other");
    lines.jobEnded(job);
    expect(screen()).toEqual([""]);
    // The REPL moves to the prompt before drawing it.
    lines.setOwner("prompt");
    rl.prompt();
    expect(screen()).toEqual([line, ">"]);
    rl.close();
  });
});
