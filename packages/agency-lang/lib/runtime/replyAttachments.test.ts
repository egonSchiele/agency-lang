import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Mock ONLY the modality probe; everything else in smoltalk is unused here.
// NOTE: this replaces the ENTIRE smoltalk module for this file — if
// replyAttachments.ts ever imports more from smoltalk, add it to the factory.
vi.mock("smoltalk", () => ({
  modelSupportsInputModality: (_model: unknown, modality: string) => {
    if (String(_model) === "text-only-model") return false;
    if (String(_model) === "unknown-model") return undefined;
    return modality === "image" || modality === "pdf";
  },
}));

import {
  harvestReplyAttachments,
  buildReplyUserMessage,
  appendReplyMarker,
  type HarvestedReplyAttachment,
  type ReplyAttachmentPart,
} from "./replyAttachments.js";
import { MAX_REPLY_ATTACHMENTS_PER_CALL } from "../config.js";

function imagePart(p: string): ReplyAttachmentPart {
  return { type: "image", source: { kind: "path", path: p } };
}

describe("harvestReplyAttachments", () => {
  it("returns empty marker and touches nothing when the queue is empty", () => {
    const runnerState: Record<string, any> = {};
    const marker = harvestReplyAttachments({
      queued: [],
      runnerState,
      model: "vision-model",
      toolName: "showChart",
    });
    expect(marker).toBe("");
    expect(runnerState.replyAttachments).toBeUndefined();
  });

  it("harvests a queued attachment: id, marker, buffer entry", () => {
    const runnerState: Record<string, any> = {};
    // The gate stats the file, so it must exist.
    fs.writeFileSync("/tmp/chart.png", Buffer.from([1]));
    const marker = harvestReplyAttachments({
      queued: [imagePart("/tmp/chart.png")],
      runnerState,
      model: "vision-model",
      toolName: "showChart",
    });

    expect(marker).toBe(
      "\n\n[attached img_1 — delivered in the user message following these tool results]",
    );
    const harvested = runnerState.replyAttachments as HarvestedReplyAttachment[];
    expect(harvested).toHaveLength(1);
    expect(harvested[0]).toMatchObject({ id: "img_1", toolName: "showChart" });
  });

  it("assigns sequential ids across harvests within one runnerState", () => {
    fs.writeFileSync("/tmp/tra-a.png", Buffer.from([1]));
    fs.writeFileSync("/tmp/tra-b.png", Buffer.from([1]));
    fs.writeFileSync("/tmp/tra-c.png", Buffer.from([1]));
    const runnerState: Record<string, any> = {};
    const markerA = harvestReplyAttachments({ queued: [imagePart("/tmp/tra-a.png")], runnerState, model: "m", toolName: "toolA" });
    const markerB = harvestReplyAttachments({ queued: [imagePart("/tmp/tra-b.png"), imagePart("/tmp/tra-c.png")], runnerState, model: "m", toolName: "toolB" });

    expect(markerA).toContain("img_1");
    expect(markerB).toContain("img_2");
    expect(markerB).toContain("img_3");
    const ids = (runnerState.replyAttachments as HarvestedReplyAttachment[]).map((h) => h.id);
    expect(ids).toEqual(["img_1", "img_2", "img_3"]);
  });

  it("separate runnerStates (parallel llm() calls) do not share counters or buffers", () => {
    // THE fork-isolation property: each runPrompt invocation owns its
    // runnerState, so parallel llm() calls cannot cross-contaminate.
    // (No e2e fork test exists — the deterministic client's mock queue
    // is module-keyed and flat, so concurrent branches consume from one
    // queue nondeterministically; the property is structural and pinned
    // here plus by the sequential-isolation execution test.)
    fs.writeFileSync("/tmp/tra-a.png", Buffer.from([1]));
    fs.writeFileSync("/tmp/tra-b.png", Buffer.from([1]));
    const runnerStateLeft: Record<string, any> = {};
    const runnerStateRight: Record<string, any> = {};
    harvestReplyAttachments({ queued: [imagePart("/tmp/tra-a.png")], runnerState: runnerStateLeft, model: "m", toolName: "t" });
    harvestReplyAttachments({ queued: [imagePart("/tmp/tra-b.png")], runnerState: runnerStateRight, model: "m", toolName: "t" });
    expect((runnerStateLeft.replyAttachments as HarvestedReplyAttachment[])[0].id).toBe("img_1");
    expect((runnerStateRight.replyAttachments as HarvestedReplyAttachment[])[0].id).toBe("img_1");
    expect(runnerStateLeft.replyAttachments).toHaveLength(1);
    expect(runnerStateRight.replyAttachments).toHaveLength(1);
  });

  it("drops attachments with a skip marker when the model has no image input", () => {
    const runnerState: Record<string, any> = {};
    const marker = harvestReplyAttachments({
      queued: [imagePart("/tmp/tra-a.png")],
      runnerState,
      model: "text-only-model",
      toolName: "showChart",
    });
    expect(marker).toBe(
      "\n\n[attachment img_1 skipped: the current model has no image input]",
    );
    expect(runnerState.replyAttachments).toEqual([]);
  });

  it("attaches optimistically when modality support is unknown (tri-state)", () => {
    fs.writeFileSync("/tmp/tra-a.png", Buffer.from([1]));
    const runnerState: Record<string, any> = {};
    const marker = harvestReplyAttachments({
      queued: [imagePart("/tmp/tra-a.png")],
      runnerState,
      model: "unknown-model",
      toolName: "t",
    });
    expect(marker).toContain("[attached img_1");
    expect(runnerState.replyAttachments).toHaveLength(1);
  });

  it("skips oversized base64 attachments at harvest", () => {
    const runnerState: Record<string, any> = {};
    // ~21 MB decoded → over the 20 MB cap. Base64 length ≈ bytes * 4/3.
    const big = "A".repeat(Math.ceil((21 * 1024 * 1024 * 4) / 3));
    const marker = harvestReplyAttachments({
      queued: [{ type: "image", source: { kind: "base64", base64: big, mimeType: "image/png" } }],
      runnerState,
      model: "m",
      toolName: "t",
    });
    expect(marker).toBe("\n\n[attachment img_1 skipped: too large to attach (over 20 MB)]");
    expect(runnerState.replyAttachments).toEqual([]);
  });

  it("skips oversized path attachments at harvest (fs.stat size)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tra-"));
    const bigFile = path.join(dir, "big.png");
    fs.writeFileSync(bigFile, Buffer.alloc(21 * 1024 * 1024));
    const runnerState: Record<string, any> = {};
    const marker = harvestReplyAttachments({ queued: [imagePart(bigFile)], runnerState, model: "m", toolName: "t" });
    expect(marker).toContain("skipped: too large to attach");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("caps the per-call total with a visible skip marker", () => {
    const runnerState: Record<string, any> = {};
    const queued: ReplyAttachmentPart[] = [];
    for (let i = 0; i < MAX_REPLY_ATTACHMENTS_PER_CALL + 1; i++) {
      fs.writeFileSync(`/tmp/tra-cap-${i}.png`, Buffer.from([1]));
      queued.push(imagePart(`/tmp/tra-cap-${i}.png`));
    }
    const marker = harvestReplyAttachments({ queued, runnerState, model: "m", toolName: "t" });
    expect(runnerState.replyAttachments).toHaveLength(MAX_REPLY_ATTACHMENTS_PER_CALL);
    expect(marker).toContain(
      "[attachment img_11 skipped: too many attachments for this llm() call (limit 10)]",
    );
  });

  it("skips a missing path file at harvest with an honest marker", () => {
    const runnerState: Record<string, any> = {};
    const marker = harvestReplyAttachments({ queued: [imagePart("/nonexistent-tra/missing.png")], runnerState, model: "m", toolName: "t" });
    expect(marker).toBe("\n\n[attachment img_1 skipped: file not found]");
    expect(runnerState.replyAttachments).toEqual([]);
  });
});

describe("appendReplyMarker", () => {
  const stringify = (value: unknown) => JSON.stringify(value);

  it("returns the capped result unchanged when there is no marker", () => {
    const structured = { rows: 3 };
    expect(appendReplyMarker(structured, "", stringify)).toBe(structured);
  });

  it("appends to string results", () => {
    expect(appendReplyMarker("done", "\n\n[attached img_1]", stringify)).toBe(
      "done\n\n[attached img_1]",
    );
  });

  it("stringifies non-string results before appending", () => {
    expect(appendReplyMarker({ rows: 3 }, "\n\n[attached img_1]", stringify)).toBe(
      '{"rows":3}\n\n[attached img_1]',
    );
  });
});

describe("buildReplyUserMessage", () => {
  it("emits a label text part before each attachment part", () => {
    const harvested: HarvestedReplyAttachment[] = [
      {
        id: "img_1",
        toolName: "showChart",
        part: { type: "image", source: { kind: "base64", base64: "AAAA", mimeType: "image/png" } },
      },
    ];
    const parts = buildReplyUserMessage(harvested) as any[];
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ type: "text", text: "[img_1 — image output of tool showChart]" });
    expect(parts[1]).toMatchObject({ type: "image", source: { kind: "base64" } });
  });

  it("inlines path sources to base64 with the extension MIME type", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tra-"));
    const file = path.join(dir, "pic.png");
    fs.writeFileSync(file, Buffer.from([1, 2, 3, 4]));
    const parts = buildReplyUserMessage([
      { id: "img_1", toolName: "t", part: { type: "image", source: { kind: "path", path: file } } },
    ]) as any[];
    expect(parts[1].source.kind).toBe("base64");
    expect(parts[1].source.base64).toBe(Buffer.from([1, 2, 3, 4]).toString("base64"));
    expect(parts[1].source.mimeType).toBe("image/png");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("replaces an unreadable path with a text part instead of throwing", () => {
    const parts = buildReplyUserMessage([
      {
        id: "img_1",
        toolName: "t",
        part: { type: "image", source: { kind: "path", path: "/nonexistent-tra/x.png" } },
      },
    ]) as any[];
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe("text");
    expect(parts[0].text).toContain("[img_1 could not be read:");
  });

  it("passes url sources through untouched and labels file parts as file output", () => {
    const parts = buildReplyUserMessage([
      {
        id: "img_1",
        toolName: "fetchDoc",
        part: { type: "file", source: { kind: "url", url: "https://example.com/r.pdf" }, filename: "r.pdf" },
      },
    ]) as any[];
    expect(parts[0].text).toBe("[img_1 — file output of tool fetchDoc]");
    expect(parts[1].source).toEqual({ kind: "url", url: "https://example.com/r.pdf" });
  });
});
