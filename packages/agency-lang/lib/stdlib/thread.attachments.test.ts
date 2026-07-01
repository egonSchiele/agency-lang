import { describe, it, expect } from "vitest";
import { _imageAttachment, _fileAttachment } from "./thread.js";

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
    expect(() => _imageAttachment("data:text/plain,hello", "", false)).toThrow(
      /base64/i,
    );
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
    expect(
      _fileAttachment("https://x.com/a/report.pdf?v=2", "", "", false),
    ).toEqual({
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
