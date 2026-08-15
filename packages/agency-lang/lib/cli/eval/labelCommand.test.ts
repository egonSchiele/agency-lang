import { Command } from "@/vendor/commander/index.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { addLabelCommand, collectRepeated, type LabelCommandDependencies } from "./labelCommand.js";

type Recorder = {
  label: unknown[];
  ingest: unknown[];
  failures: string[];
};

let recorded: Recorder;

function dependencies(): LabelCommandDependencies {
  return {
    getConfig: () => ({}),
    evalLabel: vi.fn(async (options) => {
      recorded.label.push(options);
    }) as never,
    evalIngest: vi.fn(async (options) => {
      recorded.ingest.push(options);
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
  recorded = { label: [], ingest: [], failures: [] };
});

describe("agency label", () => {
  it("labels whatever the store holds", async () => {
    await run("label", "--checklist", "news.json");
    expect(recorded.label).toEqual([expect.objectContaining({ checklist: "news.json" })]);
  });

  it("takes no positional argument, so a path is a usage error", async () => {
    await expect(run("label", "runs/abc", "--checklist", "news.json")).rejects.toThrow();
    expect(recorded.label).toEqual([]);
  });
});

describe("agency label ingest", () => {
  it("dispatches to ingest rather than treating the word as a run directory", async () => {
    await run("label", "ingest", "./gold", "--source", "handwritten");
    expect(recorded.ingest[0]).toMatchObject({ path: "./gold", source: "handwritten" });
    expect(recorded.label).toEqual([]);
  });

  it("accumulates repeated --field flags", async () => {
    await run("label", "ingest", "./gold", "--source", "s", "--field", "a=1", "--field", "b=2");
    expect(recorded.ingest[0]).toMatchObject({ field: ["a=1", "b=2"] });
  });

  it("collects extra positionals so an expanded glob can be reported", async () => {
    await run("label", "ingest", "a.txt", "b.txt", "--source", "s");
    expect(recorded.ingest[0]).toMatchObject({ path: "a.txt", extraArgs: ["b.txt"] });
  });

  it("reads --no-task-field as taskField false", async () => {
    await run("label", "ingest", "runs/a", "--source", "s", "--no-task-field");
    expect(recorded.ingest[0]).toMatchObject({ taskField: false });
  });

  it("rejects a --max-bytes that is not a positive number", async () => {
    await expect(run("label", "ingest", "./gold", "--source", "s", "--max-bytes", "0"))
      .rejects.toThrow(/positive whole number/);
  });
});

describe("option shadowing between a parent and its subcommand", () => {
  it("delivers --source to ingest, which a --source on the parent would steal", async () => {
    // Commander gives a parent's option priority over a same-named option on a
    // subcommand: with --source declared on both, this arrived at ingest as
    // undefined and the command failed claiming --source was missing. Pinned
    // here because re-adding --source to `label` would silently break it again.
    await run("label", "ingest", "./gold", "--source", "handwritten");
    expect(recorded.ingest[0]).toMatchObject({ source: "handwritten" });
  });

  it("delivers --dataset to ingest when written after the subcommand", async () => {
    // --dataset is declared once, on the parent, and read back from there. When
    // it was declared on both, the parent silently absorbed it and ingest wrote
    // to the default dataset.
    await run("label", "ingest", "./gold", "--source", "s", "--dataset", "custom-labels");
    expect(recorded.ingest[0]).toMatchObject({ dataset: "custom-labels" });
  });

  it("delivers --dataset to ingest when written before the subcommand", async () => {
    await run("label", "--dataset", "custom-labels", "ingest", "./gold", "--source", "s");
    expect(recorded.ingest[0]).toMatchObject({ dataset: "custom-labels" });
  });

  it("leaves dataset undefined when the flag is absent, so config still decides", async () => {
    await run("label", "ingest", "./gold", "--source", "s");
    expect(recorded.ingest[0]).toMatchObject({ dataset: undefined });
  });
});

describe("both registrations", () => {
  it("exposes the same subcommands under eval", async () => {
    await run("eval", "label", "ingest", "./gold", "--source", "handwritten");
    expect(recorded.ingest[0]).toMatchObject({ path: "./gold" });
  });

  it("exposes the labelling screen under eval", async () => {
    await run("eval", "label", "--checklist", "news.json");
    expect(recorded.label[0]).toMatchObject({ checklist: "news.json" });
  });

});

describe("collectRepeated", () => {
  it("appends without mutating the previous array", () => {
    const first: string[] = [];
    const second = collectRepeated("a", first);
    expect(second).toEqual(["a"]);
    expect(first).toEqual([]);
  });
});

describe("--max-bytes is parsed strictly", () => {
  // parseInt stops at the first character it cannot read, so each of these
  // silently became a tiny cap and would have skipped most of a batch.
  it("rejects a decimal", async () => {
    await expect(run("label", "ingest", "./g", "--source", "s", "--max-bytes", "1.5"))
      .rejects.toThrow(/positive whole number/);
  });

  it("rejects trailing junk", async () => {
    await expect(run("label", "ingest", "./g", "--source", "s", "--max-bytes", "12junk"))
      .rejects.toThrow(/positive whole number/);
  });

  it("rejects exponent notation", async () => {
    await expect(run("label", "ingest", "./g", "--source", "s", "--max-bytes", "1e6"))
      .rejects.toThrow(/positive whole number/);
  });

  it("rejects a negative value and zero", async () => {
    await expect(run("label", "ingest", "./g", "--source", "s", "--max-bytes", "-1"))
      .rejects.toThrow(/positive whole number/);
    await expect(run("label", "ingest", "./g", "--source", "s", "--max-bytes", "0"))
      .rejects.toThrow(/positive whole number/);
  });

  it("rejects a value beyond safe integer range", async () => {
    await expect(run("label", "ingest", "./g", "--source", "s", "--max-bytes", "9".repeat(20)))
      .rejects.toThrow(/positive whole number/);
  });

  it("accepts a plain positive integer", async () => {
    await run("label", "ingest", "./g", "--source", "s", "--max-bytes", "2048");
    expect(recorded.ingest[0]).toMatchObject({ maxBytes: 2048 });
  });
});
