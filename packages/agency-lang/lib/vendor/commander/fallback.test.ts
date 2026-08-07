import { describe, expect, test } from "vitest";
import { Command } from "./index.js";

function make() {
  const program = new Command().exitOverride();
  let output = "";
  program.configureOutput({
    writeOut: (text) => { output += text; },
    writeErr: (text) => { output += text; },
  });
  program.version("1.2.3");
  program.option("-v, --verbose", "");
  const seen: Record<string, unknown> = {};
  const run = program
    .command("run")
    .passThroughOptions()
    .option("--model <name>", "")
    .option("-i, --interactive", "")
    .option("-t, --tag <value>", "")
    .option("--policy [name]", "")
    .argument("<input>")
    .argument("[nodeArgs...]")
    .action((input, nodeArgs, _opts, cmd) => {
      Object.assign(seen, { input, nodeArgs, fallback: cmd.invokedAsFallback() });
    });
  program.command("format").alias("fmt").argument("<f>")
    .action((file) => { seen.formatted = file; });
  program.fallbackCommand("run");
  return { program, run, seen, output: () => output };
}

describe("fallbackCommand", () => {
  test("unmatched operand dispatches the real run with provenance", () => {
    const { program, seen } = make();
    program.parse(["greet.agency", "--name", "a"], { from: "user" });
    expect(seen.input).toBe("greet.agency");
    expect(seen.nodeArgs).toEqual(["--name", "a"]);
    expect(seen.fallback).toBe(true);
  });

  test("explicit run is not marked as fallback", () => {
    const { program, seen } = make();
    program.parse(["run", "greet.agency"], { from: "user" });
    expect(seen.fallback).toBe(false);
  });

  test("fallback provenance is per-parse: shorthand then explicit run", () => {
    const { program, seen } = make();
    program.parse(["greet.agency"], { from: "user" });
    expect(seen.fallback).toBe(true);
    program.parse(["run", "greet.agency"], { from: "user" });
    expect(seen.fallback).toBe(false);
  });

  test("post-input -- works through the fallback shorthand too", () => {
    const { program, run } = make();
    program.parse(["foo.agency", "--", "--tag", "5"], { from: "user" });
    expect(run.boundaryInfo()).toEqual({
      tail: ["--tag", "5"],
      viaSeparator: true,
    });
  });

  test("bare line shows root help, does not dispatch", () => {
    const { program, seen, output } = make();
    expect(() => program.parse([], { from: "user" }))
      .toThrow(expect.objectContaining({ code: "commander.help" }));
    expect(output()).toMatch(/Usage:/);
    expect(seen.input).toBeUndefined();
  });

  test("root --help is not intercepted", () => {
    const { program, seen, output } = make();
    expect(() => program.parse(["--help"], { from: "user" }))
      .toThrow(expect.objectContaining({ code: "commander.helpDisplayed" }));
    expect(output()).toMatch(/Usage:/);
    expect(seen.input).toBeUndefined();
  });

  test("root --version is not intercepted", () => {
    const { program, seen, output } = make();
    expect(() => program.parse(["--version"], { from: "user" }))
      .toThrow(expect.objectContaining({ code: "commander.version" }));
    expect(output()).toContain("1.2.3");
    expect(seen.input).toBeUndefined();
  });

  test("a known command alias dispatches its action instead of fallback", () => {
    const { program, seen } = make();
    program.parse(["fmt", "x"], { from: "user" });
    expect(seen.formatted).toBe("x");
    expect(seen.input).toBeUndefined();
  });

  test("fallbackCommand refuses a name with no command", () => {
    const program = new Command();
    expect(() => program.fallbackCommand("nonexistent")).toThrow(/no command named/);
  });
});
