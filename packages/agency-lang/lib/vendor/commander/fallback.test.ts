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
  program.command("format").alias("fmt").option("--in-place", "").argument("<f>")
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

  test("pre-input -- works through the fallback shorthand too", () => {
    const { program, run, seen } = make();
    program.parse(["--", "foo.agency", "--tag", "5"], { from: "user" });
    expect(seen.input).toBe("foo.agency");
    expect(seen.nodeArgs).toEqual(["--tag", "5"]);
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

describe("prospective fallback parsing and ownership errors", () => {
  test.each([
    // argv, expected input, expected run opts subset
    [["--model", "bar", "greet.agency"], "greet.agency", { model: "bar" }],
    [["--model=bar", "greet.agency"], "greet.agency", { model: "bar" }],
    [["-tval", "greet.agency"], "greet.agency", { tag: "val" }],
    [["-t", "val", "greet.agency"], "greet.agency", { tag: "val" }],
    [["--policy", "--", "greet.agency"], "greet.agency", { policy: true }],
    [["--policy", "-5", "greet.agency"], "greet.agency", { policy: "-5" }],
    [["-iv", "greet.agency"], "greet.agency", { interactive: true }],
    [["-it", "val", "greet.agency"], "greet.agency", { interactive: true, tag: "val" }],
  ])("prospective scan then normal parse: %j", (argv, input, opts) => {
    const { program, run, seen } = make();
    program.parse(argv as string[], { from: "user" });
    expect(seen.input).toBe(input);
    expect(seen.fallback).toBe(true);
    expect(run.opts()).toMatchObject(opts as object);
    if ((argv as string[]).includes("-iv")) {
      expect(program.opts().verbose).toBe(true);
    }
  });

  test("optional value consumes a plain token, leaving the required input missing", () => {
    const { program } = make();
    expect(() => program.parse(["--policy", "greet.agency"], { from: "user" }))
      .toThrow(/missing required argument 'input'/);
  });

  test("variadic values stop at a known option before the input", () => {
    const { program, run, seen } = make();
    run.option("--include <path...>", "");
    program.parse(["--include", "a", "b", "--interactive", "greet.agency"], { from: "user" });
    expect(run.opts().include).toEqual(["a", "b"]);
    expect(seen.input).toBe("greet.agency");
  });

  test("fallback flag before an operand naming a real command errors with the owner", () => {
    const { program } = make();
    let message = "";
    program.configureOutput({ writeErr: (text) => { message += text; } });
    expect(() =>
      program.parse(["--model", "bar", "run", "greet.agency"], { from: "user" }),
    ).toThrow();
    expect(message).toMatch(/--model/);
    expect(message).toMatch(/after 'run'/);
  });

  test("owner error works through a command alias", () => {
    const { program } = make();
    let message = "";
    program.configureOutput({ writeErr: (text) => { message += text; } });
    expect(() =>
      program.parse(["--in-place", "fmt", "x.agency"], { from: "user" }),
    ).toThrow();
    expect(message).toMatch(/--in-place/);
    expect(message).toMatch(/format/);
  });

  test("flag owned by a grandchild is named with its path", () => {
    const { program } = make();
    const label = program.command("label");
    label.command("ingest").option("--format <f>", "").argument("<src>").action(() => {});
    let message = "";
    program.configureOutput({ writeErr: (text) => { message += text; } });
    expect(() =>
      program.parse(["--format", "json", "label", "ingest", "x"], { from: "user" }),
    ).toThrow();
    expect(message).toMatch(/--format/);
    expect(message).toMatch(/label ingest/);
  });

  test("ordinary nested parent applies the same rule (no fallback configured)", () => {
    // The error is raised by `label`, which shares make()'s output collector
    // (a later configureOutput on the program would not reach it).
    const { program, output } = make();
    const label = program.command("label");
    label.command("ingest").option("--format <f>", "").argument("<src>").action(() => {});
    expect(() =>
      program.parse(["label", "--format", "json", "ingest", "x"], { from: "user" }),
    ).toThrow();
    expect(output()).toMatch(/--format/);
    expect(output()).toMatch(/after 'ingest'/);
  });

  test("selected descendant boundary stops every ancestor", () => {
    const program = new Command().exitOverride();
    program.option("-v, --verbose", "").option("-c, --config <path>", "");
    const group = program.command("group");
    let observed: Record<string, unknown> = {};
    group.command("run").passThroughOptions().argument("<input>")
      .argument("[args...]").action((input, args) => {
        observed = { input, args, root: program.opts() };
      });
    program.parse(
      ["group", "run", "-c", "cfg.json", "foo.agency", "-v"],
      { from: "user" },
    );
    expect(observed).toEqual({
      input: "foo.agency",
      args: ["-v"],
      root: { config: "cfg.json" },
    });
  });

  test("a non-boundary sibling keeps parent-priority behavior", () => {
    const program = new Command().exitOverride().option("-v, --verbose", "");
    const group = program.command("group");
    group.command("run").passThroughOptions().argument("<input>").action(() => {});
    let verbose: boolean | undefined;
    group.command("list").action(() => { verbose = program.opts().verbose; });
    program.parse(["group", "list", "-v"], { from: "user" });
    expect(verbose).toBe(true);
  });

  test("typed sibling path selects duplicate spelling with the correct arity and alias", () => {
    const program = new Command().exitOverride();
    program.command("remote").command("list").option("--format", "").action(() => {});
    const label = program.command("label");
    label.command("ingest").alias("in").option("--format <name>", "").argument("<src>").action(() => {});
    let message = "";
    program.configureOutput({ writeErr: (text) => { message += text; } });
    expect(() => program.parse(["--format", "json", "label", "in", "x"], { from: "user" })).toThrow();
    expect(message).toMatch(/--format belongs to '.*label ingest'/);
    expect(message).not.toMatch(/remote list/);
  });

  test("attached short form reports the owner on the typed path", () => {
    const program = new Command().exitOverride();
    program.command("remote").command("list").option("-t", "").action(() => {});
    program.command("label").command("ingest").option("-t <type>", "").argument("<src>").action(() => {});
    let message = "";
    program.configureOutput({ writeErr: (text) => { message += text; } });
    expect(() => program.parse(["-tjson", "label", "ingest", "x"], { from: "user" })).toThrow();
    expect(message).toMatch(/-t belongs to '.*label ingest'/);
  });

  test("unknown typo retains suggestSimilar", () => {
    // The reporter is the fallback command (run), which shares make()'s
    // output collector.
    const { program, output } = make();
    expect(() => program.parse(["--modle", "greet.agency"], { from: "user" })).toThrow();
    expect(output()).toMatch(/--model/);
  });

  test("nested isDefault parent still dispatches its default child", () => {
    const { program } = make();
    const projects = program.command("projects");
    let host: string | undefined;
    projects.command("list", { isDefault: true }).option("--host <url>", "")
      .action((opts) => { host = opts.host; });
    program.parse(["projects", "--host", "https://h"], { from: "user" });
    expect(host).toBe("https://h");
  });

  test("flag nobody owns errors as unknown option, not file-not-found", () => {
    const { program, output } = make();
    expect(() =>
      program.parse(["--nonsense", "greet.agency"], { from: "user" }),
    ).toThrow();
    expect(output()).toMatch(/unknown option/);
  });

  test("boolean long option with equals remains invalid", () => {
    const { program } = make();
    expect(() =>
      program.parse(["--interactive=true", "greet.agency"], { from: "user" }),
    ).toThrow(/unknown option '--interactive=true'/);
  });

  test("combineFlagAndOptionalValue(false) keeps the remainder as a group", () => {
    const { program, run, seen } = make();
    run.option("-o, --optional [value]", "");
    run.combineFlagAndOptionalValue(false);
    program.parse(["-oi", "greet.agency"], { from: "user" });
    expect(run.opts()).toMatchObject({ optional: true, interactive: true });
    expect(seen.input).toBe("greet.agency");
  });

  test("known short prefix does not hide an unknown suffix", () => {
    const { program } = make();
    expect(() => program.parse(["-iz", "greet.agency"], { from: "user" }))
      .toThrow(/unknown option '-z'/);
  });
});

describe("unknownFallbackOperand", () => {
  test("emits unknown-command with a suggestion from real command names", () => {
    const { program, run, output } = make();
    run.action((input, _nodeArgs, _opts, cmd) => {
      if (cmd.invokedAsFallback() && input === "formt") {
        cmd.unknownFallbackOperand(input);
      }
    });
    expect(() => program.parse(["formt"], { from: "user" })).toThrow();
    expect(output()).toMatch(/unknown command 'formt'/);
    expect(output()).toMatch(/format/);
  });

  test("an ordinary operand dispatches fallback without the diagnostic", () => {
    const { program, seen } = make();
    program.parse(["greet.agency"], { from: "user" });
    expect(seen.input).toBe("greet.agency");
    expect(seen.fallback).toBe(true);
  });
});
