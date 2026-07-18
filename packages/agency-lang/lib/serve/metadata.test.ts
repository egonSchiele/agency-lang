import { describe, expect, it, afterAll, beforeAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { collectServeMetadata } from "./metadata.js";

// A small self-contained agent: one exported node that raises a structured
// interrupt effect (app::confirm). No stdlib import needed, LLM-free.
// Verified by running the full type-check pipeline (SymbolTable.build →
// parseAgency → buildCompilationUnit → typeCheck) on this exact source from an
// os.tmpdir() file with an empty config: it yields
// interruptEffectsByFunction.main = [{ effect: "app::confirm" }]. (The parser
// alone — `pnpm run ast` — does NOT produce the effect map; the type checker
// does, so it must be verified there.)
const AGENT_SOURCE = `
export node main(x: string) {
  raise app::confirm("proceed?")
  return x
}
`;

let tmpDir: string;
let filePath: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "serve-meta-"));
  filePath = path.join(tmpDir, "agent.agency");
  fs.writeFileSync(filePath, AGENT_SOURCE, "utf-8");
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("collectServeMetadata", () => {
  it("returns the exported node names", () => {
    const meta = collectServeMetadata({ filePath, config: {} });
    expect(meta.exportedNodeNames).toContain("main");
  });

  it("returns a moduleId derived from the file path", () => {
    const meta = collectServeMetadata({ filePath, config: {} });
    expect(typeof meta.moduleId).toBe("string");
    expect(meta.moduleId.length).toBeGreaterThan(0);
  });

  it("returns an interruptEffectsByName map (main raises app::confirm)", () => {
    const meta = collectServeMetadata({ filePath, config: {} });
    expect(meta.interruptEffectsByName).toBeTypeOf("object");
    const mainEffects = (meta.interruptEffectsByName["main"] ?? []).map((e) => e.effect);
    expect(mainEffects).toContain("app::confirm");
  });
});
