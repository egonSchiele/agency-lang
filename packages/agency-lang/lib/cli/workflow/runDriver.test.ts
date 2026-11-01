import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { runDriver, type NodeRunner } from "./runDriver.js";

describe("runDriver", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(realpathSync(tmpdir()), "wf-driver-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const leftovers = () => readdirSync(path.join(dir, ".agency-tmp"));

  const call = (config = {}) => ({
    dir,
    imports: [{ module: "./notes.agency", names: ["searchNotes"] }],
    node: "wfCheckNode",
    args: ["addOne", dir],
    config,
  });

  it("runs the node with its arguments, then deletes the folder", async () => {
    const received: Parameters<NodeRunner>[0][] = [];
    const run: NodeRunner = async (args) => {
      received.push(args);
      expect(existsSync(args.agencyFile)).toBe(true);
      return { data: { answer: 1 }, stdout: "", stderr: "" };
    };
    expect(await runDriver(call(), run)).toEqual({ ok: true, data: { answer: 1 } });
    expect(received[0].nodeName).toBe("wfCheckNode");
    expect(received[0].argsString).toBe(`"addOne", ${JSON.stringify(dir)}`);
    expect(received[0].config.refuseSplices).toBe(true);
    expect(leftovers()).toEqual([]);
  });

  it("turns a throw into a failed outcome with the child's stderr, and deletes the folder", async () => {
    const run: NodeRunner = async () => {
      throw Object.assign(new Error("Command failed"), { stderr: "boom\n" });
    };
    expect(await runDriver(call(), run)).toEqual({ ok: false, message: "boom" });
    expect(leftovers()).toEqual([]);
  });

  it("clears distDir, since the driver is never precompiled", async () => {
    let distDir: string | undefined = "x";
    const run: NodeRunner = async (args) => {
      distDir = args.config.distDir;
      return { data: null, stdout: "", stderr: "" };
    };
    await runDriver(call({ distDir: "/somewhere/dist" }), run);
    expect(distDir).toBeUndefined();
  });
});
