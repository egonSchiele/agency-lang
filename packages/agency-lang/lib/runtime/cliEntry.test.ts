import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENCY_RESUME_FILE, AGENCY_RESUME_OVERRIDES } from "../constants.js";
import { runCliEntry } from "./cliEntry.js";
import { signCheckpoint } from "./checkpointChecksum.js";
import { makeCheckpoint } from "./checkpointTestHelpers.js";

const originalResumeFile = process.env[AGENCY_RESUME_FILE];
const originalOverrides = process.env[AGENCY_RESUME_OVERRIDES];
const originalKey = process.env.AGENCY_CHECKPOINT_KEY;
const dirs: string[] = [];

afterEach(() => {
  if (originalResumeFile === undefined) delete process.env[AGENCY_RESUME_FILE];
  else process.env[AGENCY_RESUME_FILE] = originalResumeFile;
  if (originalOverrides === undefined) delete process.env[AGENCY_RESUME_OVERRIDES];
  else process.env[AGENCY_RESUME_OVERRIDES] = originalOverrides;
  if (originalKey === undefined) delete process.env.AGENCY_CHECKPOINT_KEY;
  else process.env.AGENCY_CHECKPOINT_KEY = originalKey;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writeCheckpoint(value: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), "agency-cli-entry-"));
  dirs.push(dir);
  const filename = path.join(dir, "checkpoint.json");
  writeFileSync(filename, JSON.stringify(value));
  return filename;
}

describe("runCliEntry", () => {
  it("runs main when no resume carrier exists", async () => {
    delete process.env[AGENCY_RESUME_FILE];
    const runMain = vi.fn(async () => "fresh");
    const resume = vi.fn();

    await expect(runCliEntry({ runMain, resume })).resolves.toBe("fresh");
    expect(resume).not.toHaveBeenCalled();
  });

  it("resumes an unsigned checkpoint when no signing key is configured", async () => {
    delete process.env.AGENCY_CHECKPOINT_KEY;
    process.env[AGENCY_RESUME_FILE] = writeCheckpoint(makeCheckpoint().toJSON());
    const resume = vi.fn(async () => "resumed");

    await expect(runCliEntry({ runMain: vi.fn(), resume })).resolves.toBe("resumed");
    expect(resume).toHaveBeenCalledWith(expect.objectContaining({ nodeId: "main" }), {});
  });

  it("accepts a checkpoint with a valid signature", async () => {
    process.env.AGENCY_CHECKPOINT_KEY = "a".repeat(32);
    const checkpoint = makeCheckpoint();
    signCheckpoint(checkpoint);
    process.env[AGENCY_RESUME_FILE] = writeCheckpoint(checkpoint.toJSON());

    await expect(runCliEntry({ runMain: vi.fn(), resume: vi.fn(async () => 1) })).resolves.toBe(1);
  });

  it("refuses a tampered signed checkpoint", async () => {
    process.env.AGENCY_CHECKPOINT_KEY = "a".repeat(32);
    const checkpoint = makeCheckpoint({ value: 1 });
    signCheckpoint(checkpoint);
    const json = checkpoint.toJSON();
    json.nodeId = "tampered";
    process.env[AGENCY_RESUME_FILE] = writeCheckpoint(json);

    await expect(runCliEntry({ runMain: vi.fn(), resume: vi.fn() })).rejects.toThrow("checksum");
  });

  it("refuses an unsigned checkpoint when a key is configured", async () => {
    process.env.AGENCY_CHECKPOINT_KEY = "a".repeat(32);
    process.env[AGENCY_RESUME_FILE] = writeCheckpoint(makeCheckpoint().toJSON());

    await expect(runCliEntry({ runMain: vi.fn(), resume: vi.fn() })).rejects.toThrow("checksum");
  });

  it("treats an empty signing key as signing disabled", async () => {
    process.env.AGENCY_CHECKPOINT_KEY = "";
    process.env[AGENCY_RESUME_FILE] = writeCheckpoint(makeCheckpoint().toJSON());

    await expect(runCliEntry({ runMain: vi.fn(), resume: vi.fn(async () => 1) })).resolves.toBe(1);
  });

  it("rejects malformed checkpoint JSON", async () => {
    process.env[AGENCY_RESUME_FILE] = writeCheckpoint({ nodeId: "main" });

    await expect(runCliEntry({ runMain: vi.fn(), resume: vi.fn() })).rejects.toThrow(
      "valid Agency checkpoint",
    );
  });

  it("passes parsed override buckets to resume", async () => {
    process.env[AGENCY_RESUME_FILE] = writeCheckpoint(makeCheckpoint().toJSON());
    process.env[AGENCY_RESUME_OVERRIDES] = JSON.stringify({
      locals: { mood: "happy" },
      args: { name: "Ada" },
      globals: { count: 2 },
    });
    const resume = vi.fn(async () => 1);

    await runCliEntry({ runMain: vi.fn(), resume });

    expect(resume).toHaveBeenCalledWith(expect.anything(), {
      locals: { mood: "happy" },
      args: { name: "Ada" },
      globals: { count: 2 },
    });
  });
});
