import { describe, expect, test } from "vitest";
import { Command } from "./index.js";

describe("duplicate option names on one command path are construction errors", () => {
  test("child option colliding with parent long spelling throws (parent-first order)", () => {
    const program = new Command();
    program.option("-c, --config <path>", "");
    const sub = program.command("run");
    expect(() => sub.option("--config <path>", "")).toThrow(/duplicate option --config/);
  });

  test("collision on short spelling only still throws", () => {
    const program = new Command();
    program.option("-v, --verbose", "");
    const sub = program.command("run");
    expect(() => sub.option("-v, --versioned", "")).toThrow(/duplicate option -v/);
  });

  test("parent option colliding with existing child throws (child-first order)", () => {
    const program = new Command();
    const sub = program.command("run");
    sub.option("--model <name>", "");
    expect(() => program.option("--model <name>", "")).toThrow(/duplicate option --model/);
  });

  test("attach via addCommand re-checks both directions and does not mutate on failure", () => {
    const program = new Command();
    program.option("--store <dir>", "");
    const outside = new Command("label");
    outside.option("--store <dir>", "");
    expect(() => program.addCommand(outside)).toThrow(/duplicate option --store/);
    expect(outside.parent).toBeNull();
    expect(program.commands).not.toContain(outside);
  });

  test("same name on sibling commands is fine", () => {
    const program = new Command();
    program.command("run").option("--trace", "");
    expect(() => program.command("debug").option("--trace <file>", "")).not.toThrow();
  });
});
