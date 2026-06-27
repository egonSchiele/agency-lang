import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import * as smoltalk from "smoltalk";
import {
  _registerLocalModel,
  _downloadModel,
  _listDownloadedModels,
} from "../../../lib/stdlib/localModels.js";

const enabled = process.env.AGENCY_LLM_INTEGRATION === "1";
const TINY = "smollm2-135m";

// SHA256 of the curated SmolLM2-135M-Instruct-Q4_K_M.gguf file. Bump in
// lockstep with any change to the curated URI for this model. Capturing the
// hash here is a tamper canary: HF account compromise or CDN MITM that swaps
// the file fails this assertion loudly even though we only run post-merge.
//
// Captured from Hugging Face's LFS metadata for
// unsloth/SmolLM2-135M-Instruct-GGUF :: SmolLM2-135M-Instruct-Q4_K_M.gguf
// (git-LFS oid == sha256 of the file content; 105,454,144 bytes). Update this
// in lockstep with any change to the curated URI for `smollm2-135m` or if the
// upstream repo re-quantizes the file (a legitimate change, not an attack).
// If the value is ever set back to `null`, the test falls back to format-only
// (64-char hex) and loudly logs the observed hash so it can be re-captured.
const EXPECTED_SHA256: string | null =
  "ed5fa30c487b282ec156c29062f1222e5c20875a944ac98289dbd242e947f747";

let tmpHome: string;
let origHome: string | undefined;
let origModelsDir: string | undefined;

// IMPORTANT: gate the sandbox setup on `enabled` so a normal `pnpm test`
// run doesn't mutate process.env.HOME / AGENCY_MODELS_DIR (which causes
// cross-test flakiness) and so the CI cache (~/.agency-agent/models) is
// actually exercised when the suite runs there.
beforeAll(() => {
  if (!enabled) {
    return;
  }
  // Sandbox HOME + the models cache so a local `AGENCY_LLM_INTEGRATION=1`
  // run NEVER touches the dev's real ~/.agency-agent/models or ~/agency.json.
  // In CI (AGENCY_INTEGRATION_USE_REAL_HOME=1) we honor the real HOME so the
  // workflow's actions/cache step can hit ~/.agency-agent/models.
  if (process.env.AGENCY_INTEGRATION_USE_REAL_HOME === "1") {
    return;
  }
  tmpHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lm-int-")));
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
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe.runIf(enabled)("local-model integration (real download + inference)", () => {
  it("downloads a real GGUF, file exists, hash matches", { timeout: 5 * 60_000 }, async () => {
    const modelPath = await _downloadModel(TINY);
    expect(modelPath).toMatch(/\.gguf$/);
    const buf = fs.readFileSync(modelPath);
    expect(buf.length).toBeGreaterThan(10_000_000); // ~85 MB
    const got = createHash("sha256").update(buf).digest("hex");
    if (EXPECTED_SHA256 === null) {
      // Format-only fallback (placeholder mode). Once a real hash is
      // captured from a green run, paste it into EXPECTED_SHA256 and the
      // assertion below becomes a strict exact-match tamper canary.
      // eslint-disable-next-line no-console
      console.warn(
        `[local-model integration] EXPECTED_SHA256 is null; got=${got}. ` +
        `Paste this into tests/integration/local-model/smoltest.test.ts to enable strict matching.`,
      );
      expect(got).toMatch(/^[0-9a-f]{64}$/);
    } else {
      expect(got).toBe(EXPECTED_SHA256);
    }
  });

  it("second download is a no-op (uses cache)", { timeout: 2 * 60_000 }, async () => {
    const first = await _downloadModel(TINY);
    const mtime1 = fs.statSync(first).mtimeMs;
    await new Promise((r) => setTimeout(r, 200));
    const second = await _downloadModel(TINY);
    expect(second).toBe(first);
    expect(fs.statSync(second).mtimeMs).toBe(mtime1);
  });

  it("listDownloadedModels sees the downloaded file", async () => {
    await _downloadModel(TINY); // ensure present
    const listed = _listDownloadedModels();
    expect(listed.some((m) => m.name.toLowerCase().includes("smollm2-135m"))).toBe(true);
  });

  it("registers the provider and runs real inference (shape-only assertions)", { timeout: 3 * 60_000 }, async () => {
    const modelPath = await _registerLocalModel(TINY);
    const client = smoltalk.getClient({ provider: "llama-cpp", model: modelPath });
    const result = await client.textSync({
      messages: [{ role: "user", content: "Reply with one short word." }],
      temperature: 0,
    });
    expect(result.success).toBe(true);
    expect(typeof result.value.output).toBe("string");
    expect(result.value.output.length).toBeGreaterThan(0);
  });
});
