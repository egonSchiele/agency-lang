import { describe, expect, it } from "vitest";
import { insertProgramSeparator, type CliFlag } from "./runCommandLine.js";

const FLAGS: CliFlag[] = [
  { short: "-c", long: "--config", takesValue: true },
  { short: "-v", long: "--verbose", takesValue: false },
  { short: "-i", long: "--interactive", takesValue: false },
  { long: "--policy", takesValue: true },
  { long: "--max-cost", takesValue: true },
];

const N = ["node", "agency"];
const prepare = (...words: string[]) =>
  insertProgramSeparator([...N, ...words], FLAGS);

describe("insertProgramSeparator", () => {
  it("draws the line after the filename", () => {
    expect(prepare("run", "greet.agency", "--name", "alice")).toEqual({
      argv: [...N, "run", "greet.agency", "--", "--name", "alice"],
    });
  });

  it("leaves agency flags before the filename alone", () => {
    expect(
      prepare("run", "--policy", "strict", "greet.agency", "--name", "alice"),
    ).toEqual({
      argv: [
        ...N, "run", "--policy", "strict", "greet.agency", "--", "--name", "alice",
      ],
    });
  });

  it("keeps root flags working between the subcommand and the filename", () => {
    expect(prepare("run", "-c", "custom.json", "greet.agency", "--name", "a")).toEqual({
      argv: [...N, "run", "-c", "custom.json", "greet.agency", "--", "--name", "a"],
    });
    expect(prepare("run", "-v", "greet.agency")).toEqual({
      argv: [...N, "run", "-v", "greet.agency"],
    });
  });

  it("understands an attached short value, which does not eat the filename", () => {
    expect(prepare("run", "-ccustom.json", "greet.agency", "--name", "a")).toEqual({
      argv: [...N, "run", "-ccustom.json", "greet.agency", "--", "--name", "a"],
    });
  });

  it("understands a cluster of boolean short flags", () => {
    expect(prepare("run", "-iv", "greet.agency", "--name", "a")).toEqual({
      argv: [...N, "run", "-iv", "greet.agency", "--", "--name", "a"],
    });
  });

  it("understands an attached long value", () => {
    expect(prepare("run", "--policy=strict", "greet.agency", "x")).toEqual({
      argv: [...N, "run", "--policy=strict", "greet.agency", "--", "x"],
    });
  });

  it("adds nothing when the user drew the line themselves", () => {
    const argv = [...N, "run", "greet.agency", "--", "--name", "alice"];
    expect(insertProgramSeparator(argv, FLAGS)).toEqual({ argv });
  });

  it("adds nothing when there are no program arguments", () => {
    const argv = [...N, "run", "greet.agency"];
    expect(insertProgramSeparator(argv, FLAGS)).toEqual({ argv });
  });

  it("forwards an agency flag written after the filename, and says so", () => {
    const result = prepare("run", "greet.agency", "--max-cost", "5");
    expect(result.argv).toEqual([
      ...N, "run", "greet.agency", "--", "--max-cost", "5",
    ]);
    expect(result.warning).toContain("--max-cost went to your program");
  });

  it("names the flag in the spellings a naive check would miss", () => {
    for (const [spelling, reported] of [
      ["--policy=strict", "--policy"],
      ["-cfoo.json", "-c"],
      ["-iv", "-i"],
    ]) {
      const result = prepare("run", "greet.agency", spelling);
      expect(result.warning).toContain(`${reported} went to your program`);
    }
  });

  it("says nothing when the user claims the flag with a separator", () => {
    const argv = [...N, "run", "greet.agency", "--", "--max-cost", "5"];
    expect(insertProgramSeparator(argv, FLAGS)).toEqual({ argv });
  });

  it("says nothing about a flag agency does not define", () => {
    expect(
      prepare("run", "greet.agency", "--name", "alice").warning,
    ).toBeUndefined();
  });

  it("does not mistake a program's positional word for a flag", () => {
    expect(prepare("run", "greet.agency", "policy", "alice")).toEqual({
      argv: [...N, "run", "greet.agency", "--", "policy", "alice"],
    });
  });

  it("leaves other subcommands untouched", () => {
    const argv = [...N, "label", "ingest", "--store", "/tmp/s"];
    expect(insertProgramSeparator(argv, FLAGS)).toEqual({ argv });
  });

  it("finds the subcommand past leading root flags", () => {
    expect(prepare("-c", "cfg.json", "run", "greet.agency", "--name", "a")).toEqual({
      argv: [
        ...N, "-c", "cfg.json", "run", "greet.agency", "--", "--name", "a",
      ],
    });
  });
});
