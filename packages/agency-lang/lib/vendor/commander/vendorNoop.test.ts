import { describe, expect, test } from "vitest";
import { Command } from "./index.js";

describe("vendored commander v15 behavioral pins", () => {
  // The v15 --no-* change: a paired positive+negative option with an explicit
  // default must keep today's semantics (eval run --continue-on-error pattern).
  test("paired --x / --no-x with explicit default true", () => {
    const cmd = new Command().exitOverride();
    cmd
      .option("--continue-on-error", "Continue after failures", true)
      .option("--no-continue-on-error", "Stop after first failure");
    cmd.parse([], { from: "user" });
    expect(cmd.opts().continueOnError).toBe(true);
    const cmd2 = new Command().exitOverride();
    cmd2
      .option("--continue-on-error", "", true)
      .option("--no-continue-on-error", "");
    cmd2.parse(["--no-continue-on-error"], { from: "user" });
    expect(cmd2.opts().continueOnError).toBe(false);
  });

  // Parent-priority for options a subcommand reads from its parent
  // (the label --store pattern) must survive the version bump.
  test("parent option consumed wherever it sits in the parent segment", () => {
    const program = new Command().exitOverride();
    const parent = program.command("label").option("--store <dir>", "");
    let seen: string | undefined;
    parent
      .command("ingest")
      .argument("<src>")
      .action((_src, _opts, cmd) => {
        seen = cmd.parent!.opts().store;
      });
    program.parse(["label", "ingest", "x", "--store", "s"], { from: "user" });
    expect(seen).toBe("s");
  });
});
