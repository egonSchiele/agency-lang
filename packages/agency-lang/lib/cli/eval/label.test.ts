import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgencyConfigSchema } from "@/config.js";

import {
  evalLabel,
  resolveAnnotator,
  resolveDataset,
  terminalDimension,
  type EvalLabelDependencies,
} from "./label.js";

let root: string;
let sourceDir: string;
let checklistFile: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cli-label-"));
  sourceDir = path.join(root, "run");
  checklistFile = path.join(root, "news.json");
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(checklistFile, JSON.stringify({ name: "n", questions: [{ text: "Q?" }] }));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function fakeHost(run: (request: unknown) => Promise<void> = async () => {}) {
  const calls: unknown[] = [];
  return {
    host: { run: (request: unknown) => { calls.push(request); return run(request); } },
    calls,
  };
}

function dependencies(over: Partial<EvalLabelDependencies> = {}): EvalLabelDependencies {
  return {
    makeHost: () => fakeHost().host as never,
    makeScreen: () => ({ destroy: () => {} }) as never,
    isInteractive: () => true,
    environment: { USER: "adit" },
    osUserName: () => "os-account",
    ...over,
  };
}

describe("config", () => {
  it("accepts eval.labelStore", () => {
    expect(AgencyConfigSchema.safeParse({ eval: { labelStore: "labels" } }).success).toBe(true);
  });

  it("rejects a non-string labelStore", () => {
    expect(AgencyConfigSchema.safeParse({ eval: { labelStore: 5 } }).success).toBe(false);
  });
});

describe("resolveDataset", () => {
  it("accepts the preferred flag", () => {
    expect(resolveDataset({ dataset: "new" }, {})).toBe(path.resolve("new"));
  });

  it("prefers a flag over config", () => {
    expect(resolveDataset({ dataset: "flag" }, { eval: { dataset: "cfg" } }))
      .toBe(path.resolve("flag"));
  });

  it("accepts the deprecated --store alias", () => {
    expect(resolveDataset({ store: "old" }, {})).toBe(path.resolve("old"));
  });

  it("accepts the deprecated eval.labelStore alias", () => {
    expect(resolveDataset({}, { eval: { labelStore: "configured" } }))
      .toBe(path.resolve(process.cwd(), "configured"));
  });

  it("reads eval.dataset in preference to eval.labelStore", () => {
    expect(resolveDataset({}, { eval: { dataset: "c", labelStore: "c" } }))
      .toBe(path.resolve("c"));
  });

  it("accepts equal old and new values", () => {
    expect(resolveDataset(
      { dataset: "labels", store: "labels" },
      { eval: { dataset: "labels", labelStore: "labels" } },
    )).toBe(path.resolve("labels"));
  });

  it("defaults to labels/ under the invoking directory, matching runsDir", () => {
    expect(resolveDataset({}, {})).toBe(path.resolve(process.cwd(), "labels"));
  });

  it("rejects conflicting flag aliases", () => {
    expect(() => resolveDataset({ dataset: "a", store: "b" }, {}))
      .toThrow(/--dataset.*--store.*disagree/);
  });

  it("rejects conflicting config aliases", () => {
    expect(() => resolveDataset({}, { eval: { dataset: "a", labelStore: "b" } }))
      .toThrow(/eval\.dataset.*eval\.labelStore.*disagree/);
  });
});

describe("resolveAnnotator", () => {
  it("prefers the explicit flag", () => {
    expect(resolveAnnotator({ annotator: "someone" }, dependencies()))
      .toEqual({ kind: "human", id: "someone" });
  });

  it("falls back to $USER", () => {
    expect(resolveAnnotator({}, dependencies())).toEqual({ kind: "human", id: "adit" });
  });

  it("falls back to the OS account when $USER is unset", () => {
    expect(resolveAnnotator({}, dependencies({ environment: {} })))
      .toEqual({ kind: "human", id: "os-account" });
  });

  it("falls back to the literal human when nothing else is available", () => {
    const deps = dependencies({ environment: {}, osUserName: () => undefined });
    expect(resolveAnnotator({}, deps)).toEqual({ kind: "human", id: "human" });
  });

  it("ignores a blank flag rather than recording an empty annotator", () => {
    expect(resolveAnnotator({ annotator: "   " }, dependencies()))
      .toEqual({ kind: "human", id: "adit" });
  });
});

describe("evalLabel", () => {
  it("requires a checklist", async () => {
    await expect(evalLabel({ }, dependencies()))
      .rejects.toThrow(/--checklist is required/);
  });

  it("reports a missing checklist file", async () => {
    await expect(evalLabel({ checklist: path.join(root, "nope.json") }, dependencies()))
      .rejects.toThrow(/Checklist file not found/);
  });

  it("refuses a non-interactive terminal before running the host", async () => {
    const { host, calls } = fakeHost();
    const deps = dependencies({ isInteractive: () => false, makeHost: () => host as never });
    await expect(evalLabel({ checklist: checklistFile }, deps))
      .rejects.toThrow(/interactive terminal/i);
    expect(calls).toHaveLength(0);
  });

  it("destroys the screen even when the host throws", async () => {
    const destroyed = vi.fn();
    const { host } = fakeHost(async () => { throw new Error("host exploded"); });
    const deps = dependencies({
      makeHost: () => host as never,
      makeScreen: () => ({ destroy: destroyed }) as never,
    });
    await expect(evalLabel({ checklist: checklistFile }, deps))
      .rejects.toThrow(/host exploded/);
    expect(destroyed).toHaveBeenCalled();
  });

  it("runs the host with the resolved dataset, checklist and annotator", async () => {
    const { host, calls } = fakeHost();
    await evalLabel(
      { checklist: checklistFile, store: path.join(root, "store") },
      dependencies({ makeHost: () => host as never }),
    );
    expect(calls[0]).toEqual({
      datasetDir: path.resolve(root, "store"),
      checklistFile: path.resolve(checklistFile),
      annotator: { kind: "human", id: "adit" },
    });
  });

  it("propagates a host failure after destroying the screen", async () => {
    const destroyed = vi.fn();
    const { host } = fakeHost(async () => { throw new Error("store is locked"); });
    const deps = dependencies({
      makeHost: () => host as never,
      makeScreen: () => ({ destroy: destroyed }) as never,
    });
    await expect(evalLabel({ checklist: checklistFile }, deps))
      .rejects.toThrow(/store is locked/);
    expect(destroyed).toHaveBeenCalled();
  });
});

describe("terminalDimension", () => {
  it("uses a real dimension when the terminal reports one", () => {
    expect(terminalDimension(120, 100)).toBe(120);
  });

  it("falls back when a PTY reports 0, which `??` would let through", () => {
    expect(terminalDimension(0, 100)).toBe(100);
  });

  it("falls back for undefined, negative and non-finite values", () => {
    expect(terminalDimension(undefined, 100)).toBe(100);
    expect(terminalDimension(-5, 100)).toBe(100);
    expect(terminalDimension(Number.NaN, 100)).toBe(100);
  });
});
