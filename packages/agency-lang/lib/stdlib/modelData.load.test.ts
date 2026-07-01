import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearModelData, getModel, getRegisteredModelData } from "smoltalk";
import { _loadModelData } from "./llm.js";

function tmpFile(name: string, contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-models-"));
  const p = path.join(dir, name);
  fs.writeFileSync(p, contents);
  return p;
}

const A = JSON.stringify({
  schemaVersion: 1,
  generatedAt: "t",
  models: [
    { type: "text", modelName: "custom-a", provider: "acme", inputTokenCost: 1, outputTokenCost: 2, maxInputTokens: 1000, family: "a" },
    { type: "text", modelName: "shared", provider: "acme", inputTokenCost: 5, outputTokenCost: 5, maxInputTokens: 2000, family: "a" },
  ],
  hostedTools: [{ name: "tool-a" }],
});
// B adds custom-b, and overrides acme:shared's input price to 9. Models-only (no hostedTools).
const B = JSON.stringify({
  schemaVersion: 1,
  generatedAt: "t",
  models: [
    { type: "text", modelName: "custom-b", provider: "acme", inputTokenCost: 2, outputTokenCost: 3, maxInputTokens: 3000, family: "b" },
    { type: "text", modelName: "shared", provider: "acme", inputTokenCost: 9, outputTokenCost: 5, maxInputTokens: 2000, family: "a" },
  ],
});

describe("_loadModelData", () => {
  beforeEach(() => clearModelData());

  it("registers a file's models (visible via getModel) and returns its count", () => {
    const res = _loadModelData(tmpFile("a.json", A));
    expect(res).toEqual({ ok: true, count: 2, error: "" });
    expect(getModel("custom-a" as any)?.provider).toBe("acme");
  });

  it("accumulates: later load layers over earlier, overlay wins on collision", () => {
    _loadModelData(tmpFile("a.json", A));
    const res = _loadModelData(tmpFile("b.json", B));
    expect(res.ok).toBe(true);
    expect(getModel("custom-a" as any)).toBeDefined();
    expect(getModel("custom-b" as any)).toBeDefined();
    expect((getModel("shared" as any) as any)?.inputTokenCost).toBe(9); // B wins
  });

  it("preserves prior hostedTools when a later file omits them", () => {
    _loadModelData(tmpFile("a.json", A)); // has hostedTools
    _loadModelData(tmpFile("b.json", B)); // models-only
    expect((getRegisteredModelData()?.hostedTools ?? []).some((t: any) => t.name === "tool-a")).toBe(true);
  });

  it("returns count = this file's models, not the running total", () => {
    _loadModelData(tmpFile("a.json", A));            // 2
    expect(_loadModelData(tmpFile("b.json", B)).count).toBe(2); // this file's 2, not 4
  });

  it("fails on missing file / invalid JSON / no models array, leaving prior registration intact", () => {
    _loadModelData(tmpFile("a.json", A));
    expect(_loadModelData("/no/such/file.json").ok).toBe(false);
    expect(_loadModelData(tmpFile("bad.json", "{not json")).ok).toBe(false);
    expect(_loadModelData(tmpFile("nomodels.json", "{}")).ok).toBe(false);
    expect(getModel("custom-a" as any)).toBeDefined();
  });

  it("fails on schemaVersion mismatch after a prior load", () => {
    _loadModelData(tmpFile("v1.json", A)); // schemaVersion 1
    const v2 = JSON.stringify({
      schemaVersion: 2,
      models: [{ type: "text", modelName: "z", provider: "acme", inputTokenCost: 0, outputTokenCost: 0, maxInputTokens: 1 }],
    });
    const res = _loadModelData(tmpFile("v2.json", v2));
    expect(res.ok).toBe(false);
    expect(res.error).toContain("schemaVersion");
    expect(getModel("custom-a" as any)).toBeDefined(); // v1 intact
  });
});
