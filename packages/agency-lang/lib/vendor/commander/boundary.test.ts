import { describe, expect, test } from "vitest";
import { Command } from "./index.js";

function make() {
  const program = new Command().exitOverride();
  program.option("-v, --verbose", "").option("-c, --config <path>", "");
  const seen: Record<string, unknown> = {};
  const run = program
    .command("run")
    .passThroughOptions()
    .option("--model <name>", "")
    .argument("<input>")
    .argument("[nodeArgs...]")
    .action((input, nodeArgs, opts) => {
      Object.assign(seen, { input, nodeArgs, opts, rootOpts: program.opts() });
    });
  const agent = program
    .command("agent")
    .passThroughOptions({ boundary: "immediate" })
    .argument("[args...]")
    .action((args) => {
      Object.assign(seen, { agentArgs: args });
    });
  return { program, run, agent, seen };
}

describe("boundary-aware delegation", () => {
  test("root does not consume its own flag from run's program tail", () => {
    const { program, seen } = make();
    program.parse(["run", "foo.agency", "-v"], { from: "user" });
    expect(seen.nodeArgs).toEqual(["-v"]);
    expect(seen.rootOpts).not.toHaveProperty("verbose");
  });

  test("ancestor flag before the boundary is consumed and lands on the ancestor", () => {
    const { program, seen } = make();
    program.parse(["run", "-c", "cfg.json", "foo.agency"], { from: "user" });
    expect(seen.input).toBe("foo.agency");
    expect((seen.rootOpts as { config?: string }).config).toBe("cfg.json");
  });

  test("own flag before the boundary works as before", () => {
    const { program, seen } = make();
    program.parse(["run", "--model", "m", "foo.agency", "--name", "a"], { from: "user" });
    expect((seen.opts as { model?: string }).model).toBe("m");
    expect(seen.nodeArgs).toEqual(["--name", "a"]);
  });

  test("agent forwards its entire tail, root-owned spellings included", () => {
    const { program, seen } = make();
    program.parse(["agent", "-c", "cfg.json", "--verbose"], { from: "user" });
    expect(seen.agentArgs).toEqual(["-c", "cfg.json", "--verbose"]);
  });

  test("ancestor variadic option parsed by a boundary child keeps all values", () => {
    const { program, seen } = make();
    program.option("--include <path...>", "");
    // A known option ends the variadic run (upstream semantics); every value
    // before it must reach the ANCESTOR's listener, not just the first.
    program.parse(
      ["run", "--include", "a", "b", "--model", "m", "foo.agency"],
      { from: "user" },
    );
    expect(seen.input).toBe("foo.agency");
    expect((seen.opts as { model?: string }).model).toBe("m");
    expect(program.opts().include).toEqual(["a", "b"]);
  });

  test("positional boundary records tail, viaSeparator false", () => {
    const { program, run } = make();
    program.parse(["run", "foo.agency", "--max-cost", "5"], { from: "user" });
    expect(run.boundaryInfo()).toEqual({
      tail: ["--max-cost", "5"],
      viaSeparator: false,
    });
  });

  test("post-input -- records viaSeparator true, -- stripped from tail", () => {
    const { program, run, seen } = make();
    program.parse(["run", "foo.agency", "--", "--max-cost", "5"], { from: "user" });
    expect(seen.nodeArgs).toEqual(["--max-cost", "5"]);
    expect(run.boundaryInfo()).toEqual({
      tail: ["--max-cost", "5"],
      viaSeparator: true,
    });
  });

  test("pre-input -- still consumes the input and suppresses (viaSeparator true)", () => {
    const { program, run, seen } = make();
    program.parse(["run", "--", "foo.agency", "--max-cost", "5"], { from: "user" });
    expect(seen.input).toBe("foo.agency");
    expect(seen.nodeArgs).toEqual(["--max-cost", "5"]);
    expect(run.boundaryInfo()).toEqual({
      tail: ["--max-cost", "5"],
      viaSeparator: true,
    });
  });

  test("immediate boundary records the whole tail", () => {
    const { program, agent } = make();
    program.parse(["agent", "-p", "hi"], { from: "user" });
    expect(agent.boundaryInfo()).toEqual({
      tail: ["-p", "hi"],
      viaSeparator: false,
    });
  });

  test("re-parsing the same instance clears stale provenance", () => {
    const { program, run } = make();
    program.parse(["run", "foo.agency", "--max-cost", "5"], { from: "user" });
    expect(run.boundaryInfo()).toBeDefined();
    program.parse(["run", "bar.agency"], { from: "user" });
    expect(run.boundaryInfo()).toEqual({ tail: [], viaSeparator: false });
  });

  test("commands without a boundary keep parent-priority behavior", () => {
    const program = new Command().exitOverride();
    const label = program.command("label").option("--store <dir>", "");
    let store: string | undefined;
    label.command("ingest").argument("<src>").action((_s, _o, cmd) => {
      store = cmd.parent!.opts().store;
    });
    program.parse(["label", "ingest", "x", "--store", "s"], { from: "user" });
    expect(store).toBe("s");
  });
});
