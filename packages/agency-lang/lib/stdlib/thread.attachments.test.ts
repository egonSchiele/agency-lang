import { describe, it, expect, vi } from "vitest";
import { _imageAttachment, _fileAttachment, _attachToReply } from "./thread.js";
import { withRun } from "../runtime/asyncContext.js";
import { StateStack } from "../runtime/state/stateStack.js";
import { memoryHost } from "../host/memoryHost.js";

describe("_imageAttachment", () => {
  it("classifies a plain path", () => {
    expect(_imageAttachment("./cat.png", "", false)).toEqual({
      type: "image",
      source: { kind: "path", path: "./cat.png" },
    });
  });

  it("auto-detects an http(s) URL", () => {
    expect(_imageAttachment("https://x.com/a.jpg", "", false)).toEqual({
      type: "image",
      source: { kind: "url", url: "https://x.com/a.jpg" },
    });
  });

  it("parses a data: URI into a base64 source (mime from the URI)", () => {
    expect(_imageAttachment("data:image/png;base64,AAAB", "", false)).toEqual({
      type: "image",
      source: { kind: "base64", base64: "AAAB", mimeType: "image/png" },
    });
  });

  it("treats a data: URI as base64 even when base64:true is passed", () => {
    expect(_imageAttachment("data:image/png;base64,AAAB", "", true)).toEqual({
      type: "image",
      source: { kind: "base64", base64: "AAAB", mimeType: "image/png" },
    });
  });

  it("uses base64:true with an explicit mimeType", () => {
    expect(_imageAttachment("AAAB", "image/png", true)).toEqual({
      type: "image",
      source: { kind: "base64", base64: "AAAB", mimeType: "image/png" },
    });
  });

  it("lets mimeType override inference on a path", () => {
    expect(_imageAttachment("./blob", "image/webp", false)).toEqual({
      type: "image",
      source: { kind: "path", path: "./blob", mimeType: "image/webp" },
    });
  });

  it("throws on base64 with no mimeType", () => {
    expect(() => _imageAttachment("AAAB", "", true)).toThrow(/mimeType/i);
  });

  it("throws on a data: URI that is not base64-encoded", () => {
    expect(() => _imageAttachment("data:text/plain,hello", "", false)).toThrow(/base64/i);
  });
});

describe("_fileAttachment", () => {
  it("derives filename from a path basename", () => {
    expect(_fileAttachment("./docs/report.pdf", "", "", false)).toEqual({
      type: "file",
      source: { kind: "path", path: "./docs/report.pdf" },
      filename: "report.pdf",
    });
  });

  it("derives filename from a URL, stripping query/hash", () => {
    expect(_fileAttachment("https://x.com/a/report.pdf?v=2", "", "", false)).toEqual({
      type: "file",
      source: { kind: "url", url: "https://x.com/a/report.pdf?v=2" },
      filename: "report.pdf",
    });
  });

  it("respects an explicit filename", () => {
    expect(_fileAttachment("./r.pdf", "custom.pdf", "", false)).toEqual({
      type: "file",
      source: { kind: "path", path: "./r.pdf" },
      filename: "custom.pdf",
    });
  });

  it("does NOT derive a filename from a base64 source", () => {
    expect(_fileAttachment("AAAB", "", "application/pdf", true)).toEqual({
      type: "file",
      source: { kind: "base64", base64: "AAAB", mimeType: "application/pdf" },
    });
  });
});

describe("_attachToReply", () => {
  function frameWith(toolDepth: number, files: Record<string, Uint8Array> = {}) {
    const stack = new StateStack();
    const ctx = {
      isInsideToolCall: () => toolDepth > 0,
      statelogClient: { error: vi.fn() },
      host: memoryHost({ files }),
    };
    return { ctx, stack, log: ctx.statelogClient } as any;
  }

  it("reads a path source through the host and queues the bytes as base64", async () => {
    const frame = frameWith(1, { "/pics/x.png": new Uint8Array([1, 2, 3, 4]) });
    await withRun(frame, () =>
      _attachToReply({ type: "image", source: { kind: "path", path: "/pics/x.png" } }),
    );
    const queued = frame.stack.drainPendingReplyAttachments();
    expect(queued).toHaveLength(1);
    expect(queued[0].source).toEqual({
      kind: "base64",
      base64: Buffer.from([1, 2, 3, 4]).toString("base64"),
      mimeType: "image/png",
    });
    // Drain clears: a second drain is empty.
    expect(frame.stack.drainPendingReplyAttachments()).toEqual([]);
  });

  it("queues a path it cannot read as it is, for harvest to report", async () => {
    const frame = frameWith(1);
    await withRun(frame, () =>
      _attachToReply({ type: "image", source: { kind: "path", path: "/pics/missing.png" } }),
    );
    const queued = frame.stack.drainPendingReplyAttachments();
    expect(queued[0].source).toEqual({ kind: "path", path: "/pics/missing.png" });
  });

  it("drops with a statelog error outside a tool call (never throws)", async () => {
    const frame = frameWith(0);
    await withRun(frame, () =>
      _attachToReply({ type: "image", source: { kind: "path", path: "/tmp/x.png" } }),
    );
    expect(frame.stack.drainPendingReplyAttachments()).toEqual([]);
    expect(frame.ctx.statelogClient.error).toHaveBeenCalledTimes(1);
  });

  it("is a no-op outside any runtime frame", () => {
    expect(() =>
      _attachToReply({ type: "image", source: { kind: "path", path: "/tmp/x.png" } }),
    ).not.toThrow();
  });
});
