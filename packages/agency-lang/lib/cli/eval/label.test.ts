import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { writeRunGroup } from "@/eval/runDirectoryFixture.js";

import { label, resolveAnnotator, terminalDimension, type LabelDependencies } from "./label.js";

let root: string;
/** A group of two runs, `a` (trace ta) and `b` (trace tb). */
let group: string;
let checklistFile: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cli-label-"));
  group = path.join(root, "runs");
  checklistFile = path.join(root, "news.json");
  writeRunGroup(
    [
      { traceId: "ta", test: { id: "a", input: "t" }, output: "x" },
      { traceId: "tb", test: { id: "b", input: "t" }, output: "y" },
    ],
    group,
  );
  fs.writeFileSync(checklistFile, JSON.stringify({ name: "n", questions: [{ text: "Q?" }] }));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function fakeController() {
  return { snapshot: () => ({}), dispatch: async () => ({}), close: vi.fn(async () => {}) };
}

function dependencies(over: Partial<LabelDependencies> = {}): LabelDependencies {
  return {
    openSession: vi.fn(async () => fakeController() as never),
    runTui: vi.fn(async () => {}),
    makeScreen: () => ({ destroy: () => {} }) as never,
    isInteractive: () => true,
    reportWarning: () => {},
    environment: { USER: "adit" },
    osUserName: () => "os-account",
    ...over,
  };
}

describe("resolveAnnotator", () => {
  it("prefers the explicit flag", () => {
    expect(resolveAnnotator({ annotator: "someone" }, dependencies())).toEqual({
      kind: "human",
      id: "someone",
    });
  });

  it("falls back to $USER", () => {
    expect(resolveAnnotator({}, dependencies())).toEqual({ kind: "human", id: "adit" });
  });

  it("falls back to the OS account when $USER is unset", () => {
    expect(resolveAnnotator({}, dependencies({ environment: {} }))).toEqual({
      kind: "human",
      id: "os-account",
    });
  });

  it("falls back to the literal human when nothing else is available", () => {
    const deps = dependencies({ environment: {}, osUserName: () => undefined });
    expect(resolveAnnotator({}, deps)).toEqual({ kind: "human", id: "human" });
  });

  it("ignores a blank flag rather than recording an empty annotator", () => {
    expect(resolveAnnotator({ annotator: "   " }, dependencies())).toEqual({
      kind: "human",
      id: "adit",
    });
  });
});

describe("label", () => {
  it("requires a checklist", async () => {
    await expect(label({ paths: [group] }, dependencies())).rejects.toThrow(
      /--checklist is required/,
    );
  });

  it("reports a missing checklist file", async () => {
    await expect(
      label({ paths: [group], checklist: path.join(root, "nope.json") }, dependencies()),
    ).rejects.toThrow(/Checklist file not found/);
  });

  it("requires at least one path", async () => {
    await expect(label({ paths: [], checklist: checklistFile }, dependencies())).rejects.toThrow(
      /at least one run directory/,
    );
  });

  it("reports a path that is not a directory", async () => {
    await expect(
      label({ paths: [path.join(root, "nope")], checklist: checklistFile }, dependencies()),
    ).rejects.toThrow(/is not a directory/);
  });

  it("refuses a non-interactive terminal before opening a session", async () => {
    const deps = dependencies({ isInteractive: () => false });
    await expect(label({ paths: [group], checklist: checklistFile }, deps)).rejects.toThrow(
      /interactive terminal/i,
    );
    expect(deps.openSession).not.toHaveBeenCalled();
  });

  it("opens the session with the one resolved group, the checklist and the annotator", async () => {
    const deps = dependencies();
    await label(
      { paths: [path.join(group, "b"), path.join(group, "a")], checklist: checklistFile },
      deps,
    );
    expect(deps.openSession).toHaveBeenCalledTimes(1);
    const request = (deps.openSession as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(request.checklistFile).toBe(path.resolve(checklistFile));
    expect(request.annotator).toEqual({ kind: "human", id: "adit" });
    expect(fs.realpathSync(request.group.dir)).toBe(fs.realpathSync(group));
    // The paths' order is the session's order; the request carries runs, not paths.
    expect(request.group.runs.map((run: { traceId: string }) => run.traceId)).toEqual(["tb", "ta"]);
    expect(Object.keys(request)).toEqual(["group", "checklistFile", "annotator"]);
  });

  it("titles the screen after the group", async () => {
    const deps = dependencies();
    await label({ paths: [path.join(group, "a")], checklist: checklistFile }, deps);
    const call = (deps.runTui as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.title).toBe("runs");
  });

  it("closes the session and destroys the screen even when the screen throws", async () => {
    const destroyed = vi.fn();
    const controller = fakeController();
    const deps = dependencies({
      openSession: async () => controller as never,
      runTui: async () => {
        throw new Error("screen exploded");
      },
      makeScreen: () => ({ destroy: destroyed }) as never,
    });
    await expect(label({ paths: [group], checklist: checklistFile }, deps)).rejects.toThrow(
      /screen exploded/,
    );
    expect(controller.close).toHaveBeenCalled();
    expect(destroyed).toHaveBeenCalled();
  });

  it("closes the session when the screen cannot be created", async () => {
    const controller = fakeController();
    const deps = dependencies({
      openSession: async () => controller as never,
      makeScreen: () => {
        throw new Error("no terminal");
      },
    });
    await expect(label({ paths: [group], checklist: checklistFile }, deps)).rejects.toThrow(
      /no terminal/,
    );
    expect(controller.close).toHaveBeenCalled();
  });

  it("propagates an open failure without touching the terminal", async () => {
    const made = vi.fn();
    const deps = dependencies({
      openSession: async () => {
        throw new Error("directory is locked");
      },
      makeScreen: made as never,
    });
    await expect(label({ paths: [group], checklist: checklistFile }, deps)).rejects.toThrow(
      /directory is locked/,
    );
    expect(made).not.toHaveBeenCalled();
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
