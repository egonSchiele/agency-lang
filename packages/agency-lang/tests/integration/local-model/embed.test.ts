import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as smoltalk from "smoltalk";
import { _registerLocalModel } from "../../../lib/stdlib/localModels.js";
import { safeDeleteDirectoryWithin } from "../../../lib/utils.js";

// The catalog's embedding model, for real: download (verified against the
// catalog's pinned hash by _registerLocalModel), then vectors from
// smoltalk-llama-cpp's embed. Post-merge only, like smoltest.test.ts.
const enabled = process.env.AGENCY_LLM_INTEGRATION === "1";
const EMBED = "nomic-embed-text";

let tmpHome: string;
let origHome: string | undefined;
let origModelsDir: string | undefined;

beforeAll(() => {
  if (!enabled || process.env.AGENCY_INTEGRATION_USE_REAL_HOME === "1") {
    return;
  }
  tmpHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lm-embed-")));
  origHome = process.env.HOME;
  origModelsDir = process.env.AGENCY_MODELS_DIR;
  process.env.HOME = tmpHome;
  process.env.AGENCY_MODELS_DIR = path.join(tmpHome, "models");
});

afterAll(() => {
  if (!enabled || process.env.AGENCY_INTEGRATION_USE_REAL_HOME === "1") {
    return;
  }
  process.env.HOME = origHome;
  if (origModelsDir === undefined) {
    delete process.env.AGENCY_MODELS_DIR;
  } else {
    process.env.AGENCY_MODELS_DIR = origModelsDir;
  }
  safeDeleteDirectoryWithin(os.tmpdir(), tmpHome);
});

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / Math.sqrt(na * nb);
}

describe.runIf(enabled)("local embeddings (real download + real vectors)", () => {
  it(
    "embeds three sentences and ranks the paraphrase above the stranger",
    { timeout: 5 * 60_000 },
    async () => {
      const modelPath = await _registerLocalModel(EMBED);
      expect(modelPath).toMatch(/\.gguf$/);
      const result = await smoltalk.embed(
        [
          "The capital of France is Paris.",
          "Paris is the capital city of France.",
          "Gravity pulls objects toward each other.",
        ],
        { provider: "llama-cpp", model: modelPath },
      );
      expect(result.success).toBe(true);
      if (!result.success) return;
      const [a, b, c] = result.value.embeddings;
      expect(a).toHaveLength(768);
      const paraphrase = cosine(a, b);
      const stranger = cosine(a, c);
      console.log(`[embed] paraphrase=${paraphrase.toFixed(3)} stranger=${stranger.toFixed(3)}`);
      expect(paraphrase).toBeGreaterThan(stranger + 0.2);
      expect(result.value.tokenUsage?.inputTokens).toBeGreaterThan(0);
      expect(result.value.costEstimate?.totalCost).toBe(0);
    },
  );

  it("truncates to the dimensions asked for", { timeout: 2 * 60_000 }, async () => {
    const modelPath = await _registerLocalModel(EMBED);
    const result = await smoltalk.embed("hello", {
      provider: "llama-cpp",
      model: modelPath,
      dimensions: 256,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.embeddings[0]).toHaveLength(256);
    }
  });
});
