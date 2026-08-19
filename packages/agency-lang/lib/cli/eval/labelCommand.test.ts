import { Command } from "@/vendor/commander/index.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { addLabelCommand, type LabelCommandDependencies } from "./labelCommand.js";

let recorded: { label: unknown[]; failures: string[] };

function dependencies(): LabelCommandDependencies {
  return {
    label: vi.fn(async (options) => {
      recorded.label.push(options);
    }) as never,
    fail: (message) => recorded.failures.push(message),
  };
}

/** Both registrations on one program, exactly as the CLI wires them. */
function program(): Command {
  const root = new Command();
  root.exitOverride();
  root.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  const evalCmd = root.command("eval");
  addLabelCommand(evalCmd, dependencies());
  addLabelCommand(root, dependencies());
  return root;
}

async function run(...argv: string[]): Promise<void> {
  await program().parseAsync(argv, { from: "user" });
}

beforeEach(() => {
  recorded = { label: [], failures: [] };
});

describe("agency label", () => {
  it("passes every path it is given, in order", async () => {
    await run(
      "label",
      "runs/2026",
      "runs/2027/a",
      "--checklist",
      "news.json",
      "--annotator",
      "adit",
    );
    expect(recorded.label).toEqual([
      { paths: ["runs/2026", "runs/2027/a"], checklist: "news.json", annotator: "adit" },
    ]);
  });

  it("requires at least one path", async () => {
    await expect(run("label", "--checklist", "news.json")).rejects.toThrow();
    expect(recorded.label).toHaveLength(0);
  });

  it("reports a failure through fail rather than throwing", async () => {
    const deps = dependencies();
    deps.label = vi.fn(async () => {
      throw new Error("no such directory");
    }) as never;
    const root = new Command();
    root.exitOverride();
    addLabelCommand(root, deps);
    await root.parseAsync(["label", "x", "--checklist", "c.json"], { from: "user" });
    expect(recorded.failures).toEqual(["no such directory"]);
  });
});

describe("both registrations", () => {
  it("exposes the labelling screen under eval too", async () => {
    await run("eval", "label", "runs/2026", "--checklist", "news.json");
    expect(recorded.label).toHaveLength(1);
  });
});
