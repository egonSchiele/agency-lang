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

  it("reports an agency flag written after the filename", () => {
    expect(prepare("run", "greet.agency", "--max-cost", "5")).toEqual({
      misplaced: "--max-cost",
      input: "greet.agency",
    });
  });

  it("reports an attached short agency flag after the filename", () => {
    expect(prepare("run", "greet.agency", "-cfoo.json")).toEqual({
      misplaced: "-c",
      input: "greet.agency",
    });
  });

  it("reports an agency flag hidden in a short cluster after the filename", () => {
    expect(prepare("run", "greet.agency", "-iv")).toEqual({
      misplaced: "-i",
      input: "greet.agency",
    });
  });

  it("reports an attached long agency flag after the filename", () => {
    expect(prepare("run", "greet.agency", "--policy=strict")).toEqual({
      misplaced: "--policy",
      input: "greet.agency",
    });
  });

  it("lets an agency flag through once the user claims it with a separator", () => {
    const argv = [...N, "run", "greet.agency", "--", "--max-cost", "5"];
    expect(insertProgramSeparator(argv, FLAGS)).toEqual({ argv });
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
