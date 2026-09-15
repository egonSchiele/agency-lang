import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENCY_ENTRY_NODE, AGENCY_RESUME_FILE, AGENCY_RESUME_OVERRIDES } from "../constants.js";
import { runCliEntry } from "./cliEntry.js";
import { signCheckpoint } from "./checkpointChecksum.js";
import { makeCheckpoint } from "./checkpointTestHelpers.js";

const originalResumeFile = process.env[AGENCY_RESUME_FILE];
const originalOverrides = process.env[AGENCY_RESUME_OVERRIDES];
const originalKey = process.env.AGENCY_CHECKPOINT_KEY;
const originalForce = process.env.AGENCY_RESUME_FORCE;
const originalEntryNode = process.env[AGENCY_ENTRY_NODE];
const dirs: string[] = [];

afterEach(() => {
  if (originalResumeFile === undefined) delete process.env[AGENCY_RESUME_FILE];
  else process.env[AGENCY_RESUME_FILE] = originalResumeFile;
  if (originalOverrides === undefined) delete process.env[AGENCY_RESUME_OVERRIDES];
  else process.env[AGENCY_RESUME_OVERRIDES] = originalOverrides;
  if (originalKey === undefined) delete process.env.AGENCY_CHECKPOINT_KEY;
  else process.env.AGENCY_CHECKPOINT_KEY = originalKey;
  if (originalForce === undefined) delete process.env.AGENCY_RESUME_FORCE;
  else process.env.AGENCY_RESUME_FORCE = originalForce;
  if (originalEntryNode === undefined) delete process.env[AGENCY_ENTRY_NODE];
  else process.env[AGENCY_ENTRY_NODE] = originalEntryNode;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function writeCheckpoint(value: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), "agency-cli-entry-"));
  dirs.push(dir);
  const filename = path.join(dir, "checkpoint.json");
  writeFileSync(filename, JSON.stringify(value));
  return filename;
}

describe("runCliEntry", () => {
  it("starts main when no resume carrier or entry node exists", async () => {
    delete process.env[AGENCY_RESUME_FILE];
    delete process.env[AGENCY_ENTRY_NODE];
    const startNode = vi.fn(async (name: string) => `ran ${name}`);
    const resume = vi.fn();

    await expect(runCliEntry({ nodeNames: ["main", "list"], startNode, resume })).resolves.toBe(
      "ran main",
    );
    expect(resume).not.toHaveBeenCalled();
  });

  it("starts the node the entry carrier names", async () => {
    delete process.env[AGENCY_RESUME_FILE];
    process.env[AGENCY_ENTRY_NODE] = "list";
    const startNode = vi.fn(async (name: string) => `ran ${name}`);

    await expect(
      runCliEntry({ nodeNames: ["main", "list"], startNode, resume: vi.fn() }),
    ).resolves.toBe("ran list");
  });

  /** Stand in for process.exit, which would end the test runner. */
  function trapExit(): { code: number | undefined; stderr: string[] } {
    const trapped: { code: number | undefined; stderr: string[] } = { code: undefined, stderr: [] };
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      trapped.code = code;
      throw new Error("exit");
    }) as never);
    vi.spyOn(console, "error").mockImplementation((line: string) => {
      trapped.stderr.push(line);
    });
    return trapped;
  }

  it("names the file's nodes and exits when the requested node does not exist", async () => {
    delete process.env[AGENCY_RESUME_FILE];
    process.env[AGENCY_ENTRY_NODE] = "nope";
    const startNode = vi.fn();
    const trapped = trapExit();

    await expect(
      runCliEntry({ nodeNames: ["main", "list"], startNode, resume: vi.fn() }),
    ).rejects.toThrow("exit");
    expect(trapped.code).toBe(2);
    expect(trapped.stderr).toEqual([
      'This file has no node named "nope". Its nodes are: main, list',
    ]);
    expect(startNode).not.toHaveBeenCalled();
  });

  it("refuses to guess when the file has no main and no node was named", async () => {
    delete process.env[AGENCY_RESUME_FILE];
    delete process.env[AGENCY_ENTRY_NODE];
    const trapped = trapExit();

    await expect(
      runCliEntry({ nodeNames: ["list"], startNode: vi.fn(), resume: vi.fn() }),
    ).rejects.toThrow("exit");
    expect(trapped.stderr[0]).toContain('no node named "main"');
  });

  it("resumes an unsigned checkpoint when no signing key is configured", async () => {
    delete process.env.AGENCY_CHECKPOINT_KEY;
    process.env[AGENCY_RESUME_FILE] = writeCheckpoint(makeCheckpoint().toJSON());
    const resume = vi.fn(async () => "resumed");

    await expect(runCliEntry({ nodeNames: [], startNode: vi.fn(), resume })).resolves.toBe(
      "resumed",
    );
    expect(resume).toHaveBeenCalledWith(expect.objectContaining({ nodeId: "main" }), {});
  });

  it("accepts a checkpoint with a valid signature", async () => {
    process.env.AGENCY_CHECKPOINT_KEY = "a".repeat(32);
    const checkpoint = makeCheckpoint();
    signCheckpoint(checkpoint);
    process.env[AGENCY_RESUME_FILE] = writeCheckpoint(checkpoint.toJSON());

    await expect(
      runCliEntry({ nodeNames: [], startNode: vi.fn(), resume: vi.fn(async () => 1) }),
    ).resolves.toBe(1);
  });

  it("refuses a tampered signed checkpoint", async () => {
    process.env.AGENCY_CHECKPOINT_KEY = "a".repeat(32);
    const checkpoint = makeCheckpoint({ value: 1 });
    signCheckpoint(checkpoint);
    const json = checkpoint.toJSON();
    json.nodeId = "tampered";
    process.env[AGENCY_RESUME_FILE] = writeCheckpoint(json);

    await expect(
      runCliEntry({ nodeNames: [], startNode: vi.fn(), resume: vi.fn() }),
    ).rejects.toThrow("checksum");
  });

  it("allows a tampered signed checkpoint with the force carrier", async () => {
    process.env.AGENCY_CHECKPOINT_KEY = "a".repeat(32);
    process.env.AGENCY_RESUME_FORCE = "1";
    const checkpoint = makeCheckpoint({ value: 1 });
    signCheckpoint(checkpoint);
    const json = checkpoint.toJSON();
    json.nodeId = "tampered";
    process.env[AGENCY_RESUME_FILE] = writeCheckpoint(json);

    await expect(
      runCliEntry({ nodeNames: [], startNode: vi.fn(), resume: vi.fn(async () => 1) }),
    ).resolves.toBe(1);
  });

  it("accepts an unsigned checkpoint when a key is configured", async () => {
    process.env.AGENCY_CHECKPOINT_KEY = "a".repeat(32);
    process.env[AGENCY_RESUME_FILE] = writeCheckpoint(makeCheckpoint().toJSON());

    await expect(
      runCliEntry({ nodeNames: [], startNode: vi.fn(), resume: vi.fn(async () => 1) }),
    ).resolves.toBe(1);
  });

  it("treats an empty signing key as signing disabled", async () => {
    process.env.AGENCY_CHECKPOINT_KEY = "";
    process.env[AGENCY_RESUME_FILE] = writeCheckpoint(makeCheckpoint().toJSON());

    await expect(
      runCliEntry({ nodeNames: [], startNode: vi.fn(), resume: vi.fn(async () => 1) }),
    ).resolves.toBe(1);
  });

  it("rejects malformed checkpoint JSON", async () => {
    process.env[AGENCY_RESUME_FILE] = writeCheckpoint({ nodeId: "main" });

    await expect(
      runCliEntry({ nodeNames: [], startNode: vi.fn(), resume: vi.fn() }),
    ).rejects.toThrow("valid Agency checkpoint");
  });

  it("rejects malformed checkpoint JSON before checking its signature", async () => {
    process.env.AGENCY_CHECKPOINT_KEY = "a".repeat(32);
    process.env[AGENCY_RESUME_FILE] = writeCheckpoint(null);

    await expect(
      runCliEntry({ nodeNames: [], startNode: vi.fn(), resume: vi.fn() }),
    ).rejects.toThrow("valid Agency checkpoint");
  });

  it("passes parsed override buckets to resume", async () => {
    process.env[AGENCY_RESUME_FILE] = writeCheckpoint(makeCheckpoint().toJSON());
    process.env[AGENCY_RESUME_OVERRIDES] = JSON.stringify({
      locals: { mood: "happy" },
      args: { name: "Ada" },
      globals: { count: 2 },
    });
    const resume = vi.fn(async () => 1);

    await runCliEntry({ nodeNames: [], startNode: vi.fn(), resume });

    expect(resume).toHaveBeenCalledWith(expect.anything(), {
      locals: { mood: "happy" },
      args: { name: "Ada" },
      globals: { count: 2 },
    });
  });
});
