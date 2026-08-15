import { describe, expect, test } from "vitest";
import { Command } from "../vendor/commander/index.js";
import { warnMisplacedAgencyFlags } from "./commandLine.js";

/** A real parse through a run-shaped boundary command — no stubbed state. */
function parseRun(tail: string[]): { run: Command; input: string } {
  const program = new Command().exitOverride();
  program.option("-c, --config <path>", "");
  let input = "";
  const run = program
    .command("run")
    .passThroughOptions()
    .option("--max-cost <dollars>", "")
    .option("-i, --interactive", "")
    .option("--policy <p>", "");
  run
    .argument("<input>")
    .argument("[args...]")
    .action((value: string) => {
      input = value;
    });
  program.parse(["run", "f.agency", ...tail], { from: "user" });
  return { run, input };
}

describe("warnMisplacedAgencyFlags", () => {
  test.each([[["--max-cost", "5"]], [["--policy=strict"]], [["-cx.json"]], [["-iv"]]])(
    "warns for %j",
    (tail) => {
      const { run, input } = parseRun(tail);
      expect(warnMisplacedAgencyFlags(run, input)).toMatch(/went to your program/);
    },
  );

  test("explicit -- suppresses", () => {
    const { run, input } = parseRun(["--", "--max-cost", "5"]);
    expect(warnMisplacedAgencyFlags(run, input)).toBeUndefined();
  });

  test("-print does not warn", () => {
    const { run, input } = parseRun(["-print"]);
    expect(warnMisplacedAgencyFlags(run, input)).toBeUndefined();
  });

  test("a tail nobody owns does not warn", () => {
    const { run, input } = parseRun(["--name", "alice"]);
    expect(warnMisplacedAgencyFlags(run, input)).toBeUndefined();
  });

  test("a command that never reached a boundary does not warn", () => {
    const program = new Command().exitOverride();
    const other = program.command("other").action(() => {});
    program.parse(["other"], { from: "user" });
    expect(warnMisplacedAgencyFlags(other, "x")).toBeUndefined();
  });
});
