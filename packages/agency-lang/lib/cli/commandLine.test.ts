import { describe, expect, it } from "vitest";
import {
  splitCommandLine,
  findSubcommandIndex,
  type Boundary,
  type CliOption,
} from "./commandLine.js";

const ROOT: CliOption[] = [
  { short: "-c", long: "--config", arity: "required" },
  { short: "-v", long: "--verbose", arity: "none" },
];

const RUN_OPTIONS: CliOption[] = [
  ...ROOT,
  { short: "-i", long: "--interactive", arity: "none" },
  { long: "--policy", arity: "required" },
  { long: "--max-cost", arity: "required" },
  { long: "--trace", arity: "none" },
  // No run option is optional-valued any more — splitting `--trace [file]` is
  // what removed the last one. This synthetic flag keeps the optional path
  // covered, because Boundary offers the arity and the walker must honour it.
  { long: "--snapshot", arity: "optional" },
  { long: "--trace-file", arity: "required" },
];

const BOUNDARIES: Boundary[] = [
  { command: "run", ownedPositionals: 1, options: RUN_OPTIONS, warnOnCollision: true },
  {
    command: "agent",
    ownedPositionals: 0,
    options: [{ long: "--max-cost", arity: "required" }],
    warnOnCollision: false,
  },
];

const N = ["node", "agency"];
const split = (...words: string[]) =>
  splitCommandLine([...N, ...words], ROOT, BOUNDARIES);

describe("splitCommandLine: run", () => {
  it("draws the line after the filename", () => {
    expect(split("run", "greet.agency", "--name", "alice")).toEqual({
      argv: [...N, "run", "greet.agency", "--", "--name", "alice"],
    });
  });

  it("leaves agency flags before the filename alone", () => {
    expect(split("run", "--policy", "strict", "greet.agency", "--name", "a"))
      .toEqual({
        argv: [
          ...N, "run", "--policy", "strict", "greet.agency", "--", "--name", "a",
        ],
      });
  });

  it("keeps root flags working between the subcommand and the filename", () => {
    expect(split("run", "-c", "custom.json", "greet.agency", "--name", "a"))
      .toEqual({
        argv: [
          ...N, "run", "-c", "custom.json", "greet.agency", "--", "--name", "a",
        ],
      });
  });

  it("does not let an attached or clustered value eat the filename", () => {
    expect(split("run", "-ccustom.json", "greet.agency", "x")).toEqual({
      argv: [...N, "run", "-ccustom.json", "greet.agency", "--", "x"],
    });
    expect(split("run", "-vc", "custom.json", "greet.agency", "x")).toEqual({
      argv: [...N, "run", "-vc", "custom.json", "greet.agency", "--", "x"],
    });
    expect(split("run", "-iv", "greet.agency", "x")).toEqual({
      argv: [...N, "run", "-iv", "greet.agency", "--", "x"],
    });
  });

  it("adds nothing when the user drew the line, or has no program arguments", () => {
    for (const argv of [
      [...N, "run", "greet.agency", "--", "--name", "alice"],
      [...N, "run", "greet.agency"],
      [...N, "run", "-v", "greet.agency"],
    ]) {
      expect(splitCommandLine(argv, ROOT, BOUNDARIES)).toEqual({ argv });
    }
  });

  it("forwards an agency flag written after the filename, and says so", () => {
    const result = split("run", "greet.agency", "--max-cost", "5");
    expect(result.argv).toEqual([
      ...N, "run", "greet.agency", "--", "--max-cost", "5",
    ]);
    expect(result.warning).toContain("--max-cost went to your program");
  });

  it("names the flag in every spelling commander accepts", () => {
    for (const [spelling, reported] of [
      ["--policy=strict", "--policy"],
      ["-cfoo.json", "-c"],
      ["-iv", "-i"],
      ["-vc", "-v"],
    ]) {
      expect(split("run", "greet.agency", spelling).warning).toContain(
        `${reported} went to your program`,
      );
    }
  });

  it("stays quiet about a short token agency does not own", () => {
    // -print is the program's flag. Reading every letter would find the `i`
    // and warn about agency's -i.
    expect(split("run", "greet.agency", "-print").warning).toBeUndefined();
    expect(split("run", "greet.agency", "--name", "alice").warning)
      .toBeUndefined();
  });

  it("stays quiet when the user claimed the flag with a separator", () => {
    const argv = [...N, "run", "greet.agency", "--", "--max-cost", "5"];
    expect(splitCommandLine(argv, ROOT, BOUNDARIES)).toEqual({ argv });
  });

  it("matches commander on what an optional value swallows", () => {
    // A flag-looking next token is left alone, so --snapshot stays bare...
    expect(split("run", "--snapshot", "-i", "greet.agency", "x")).toEqual({
      argv: [...N, "run", "--snapshot", "-i", "greet.agency", "--", "x"],
    });
    expect(split("run", "--snapshot", "--interactive", "greet.agency", "x"))
      .toEqual({
        argv: [
          ...N, "run", "--snapshot", "--interactive", "greet.agency", "--", "x",
        ],
      });
    // ...but a negative number is a value, not a flag, so it is swallowed and
    // the filename is the token after it.
    expect(split("run", "--snapshot", "-5", "greet.agency", "x")).toEqual({
      argv: [...N, "run", "--snapshot", "-5", "greet.agency", "--", "x"],
    });
  });

  it("lets a required value swallow even a flag, as commander does", () => {
    expect(split("run", "--policy", "--interactive", "greet.agency", "x")).toEqual({
      argv: [...N, "run", "--policy", "--interactive", "greet.agency", "--", "x"],
    });
  });

  it("keeps the filename for both trace spellings", () => {
    expect(split("run", "--trace", "greet.agency", "x")).toEqual({
      argv: [...N, "run", "--trace", "greet.agency", "--", "x"],
    });
    expect(split("run", "--trace-file", "out.trace", "greet.agency", "x"))
      .toEqual({
        argv: [
          ...N, "run", "--trace-file", "out.trace", "greet.agency", "--", "x",
        ],
      });
  });
});

describe("splitCommandLine: agent", () => {
  it("draws the line right after the subcommand", () => {
    expect(split("agent", "-p", "task")).toEqual({
      argv: [...N, "agent", "--", "-p", "task"],
    });
  });

  it("keeps the budget flags on agency's side", () => {
    expect(split("agent", "--max-cost", "5", "-p", "task")).toEqual({
      argv: [...N, "agent", "--max-cost", "5", "--", "-p", "task"],
    });
  });

  it("never warns, because forwarding is the whole point", () => {
    expect(split("agent", "--max-cost", "5", "--max-cost", "9").warning)
      .toBeUndefined();
  });
});

describe("splitCommandLine: other commands", () => {
  it("leaves a command with no boundary untouched", () => {
    const argv = [...N, "label", "ingest", "--store", "/tmp/s"];
    expect(splitCommandLine(argv, ROOT, BOUNDARIES)).toEqual({ argv });
  });
});

describe("findSubcommandIndex", () => {
  it("finds the subcommand past root flags in every spelling", () => {
    for (const words of [
      ["run"],
      ["-v", "run"],
      ["-c", "cfg.json", "run"],
      ["-ccfg.json", "run"],
      ["-vc", "cfg.json", "run"],
      ["--config=cfg.json", "run"],
    ]) {
      const argv = [...N, ...words, "greet.agency"];
      expect(argv[findSubcommandIndex(argv, ROOT)]).toBe("run");
    }
  });

  it("reports none when there is no subcommand", () => {
    expect(findSubcommandIndex([...N], ROOT)).toBe(-1);
    expect(findSubcommandIndex([...N, "-v"], ROOT)).toBe(-1);
  });
});
