import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgencyConfigSchema } from "@/config.js";
import type { LabelingSessionController } from "@/eval/label/controller.js";

import {
  evalLabel,
  resolveAnnotator,
  resolveLabelStore,
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

function fakeController(): LabelingSessionController & { closed: () => number } {
  let closeCount = 0;
  return {
    snapshot: () => ({}) as never,
    dispatch: async () => ({}) as never,
    close: async () => { closeCount += 1; },
    closed: () => closeCount,
  };
}

function dependencies(over: Partial<EvalLabelDependencies> = {}): EvalLabelDependencies {
  return {
    openSession: vi.fn(async () => fakeController()) as never,
    runTui: vi.fn(async () => {}) as never,
    input: { isTTY: true } as NodeJS.ReadStream,
    output: { isTTY: true } as NodeJS.WriteStream,
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

describe("resolveLabelStore", () => {
  it("prefers the explicit flag", () => {
    expect(resolveLabelStore({ store: "/tmp/explicit" }, {})).toBe(path.resolve("/tmp/explicit"));
  });

  it("falls back to eval.labelStore", () => {
    expect(resolveLabelStore({}, { eval: { labelStore: "my-labels" } }))
      .toBe(path.resolve(process.cwd(), "my-labels"));
  });

  it("defaults to labels/ under the invoking directory, matching runsDir", () => {
    expect(resolveLabelStore({}, {})).toBe(path.resolve(process.cwd(), "labels"));
  });

  it("resolves a relative configured path from the invoking directory", () => {
    expect(resolveLabelStore({}, { eval: { labelStore: "./nested/labels" } }))
      .toBe(path.resolve(process.cwd(), "nested/labels"));
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
    await expect(evalLabel({ source: sourceDir }, dependencies()))
      .rejects.toThrow(/--checklist is required/);
  });

  it("reports a missing checklist file", async () => {
    await expect(evalLabel({ source: sourceDir, checklist: path.join(root, "nope.json") }, dependencies()))
      .rejects.toThrow(/Checklist file not found/);
  });

  it("reports a missing source directory", async () => {
    await expect(evalLabel({ source: path.join(root, "nope"), checklist: checklistFile }, dependencies()))
      .rejects.toThrow(/Source run directory not found/);
  });

  it("opens a session with resolved paths and annotator", async () => {
    const openSession = vi.fn(async () => fakeController());
    await evalLabel(
      { source: sourceDir, checklist: checklistFile, store: path.join(root, "store") },
      dependencies({ openSession: openSession as never }),
    );
    expect(openSession).toHaveBeenCalledWith(expect.objectContaining({
      sourceDir: path.resolve(sourceDir),
      storeDir: path.resolve(root, "store"),
      checklistFile: path.resolve(checklistFile),
      annotator: { kind: "human", id: "adit" },
    }));
  });

  it("closes the session when the terminal loop throws", async () => {
    const controller = fakeController();
    const deps = dependencies({
      openSession: (async () => controller) as never,
      runTui: (async () => { throw new Error("tui exploded"); }) as never,
    });
    await expect(evalLabel({ source: sourceDir, checklist: checklistFile }, deps))
      .rejects.toThrow(/tui exploded/);
    expect(controller.closed()).toBe(1);
  });

  it("closes the session on a clean exit", async () => {
    const controller = fakeController();
    const deps = dependencies({ openSession: (async () => controller) as never });
    await evalLabel({ source: sourceDir, checklist: checklistFile }, deps);
    expect(controller.closed()).toBe(1);
  });

  it("propagates a session-opening failure without trying to close", async () => {
    const deps = dependencies({
      openSession: (async () => { throw new Error("store is locked"); }) as never,
    });
    await expect(evalLabel({ source: sourceDir, checklist: checklistFile }, deps))
      .rejects.toThrow(/store is locked/);
  });
});
