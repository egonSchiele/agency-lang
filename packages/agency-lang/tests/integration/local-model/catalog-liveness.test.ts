import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CURATED_LOCAL_MODELS } from "../../../lib/stdlib/localModels.js";

// Catalog liveness: assert every curated short name's Hugging Face URI still
// resolves to a real, downloadable file — WITHOUT downloading any weights.
// `createModelDownloader()` fetches the HF manifest (and 401s/404s on a wrong
// or gated repo, or throws if the `:quant` tag matches no file) and computes
// the total size; we never call `.download()`. This is the guard that would
// have caught the dead `HuggingFaceTB/...` and `bartowski/...` URIs before a
// user hit them.
//
// Gated on AGENCY_LLM_INTEGRATION=1 (network required); runs post-merge via
// .github/workflows/local-model.yml. Lightweight — manifest fetches only, no
// GB downloads.
const enabled = process.env.AGENCY_LLM_INTEGRATION === "1";

let dir: string;
beforeAll(() => {
  if (enabled) {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lm-live-")));
  }
});
afterAll(() => {
  if (enabled && dir) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe.runIf(enabled)("curated catalog liveness (HF manifest resolves; no weights)", () => {
  for (const [name, info] of Object.entries(CURATED_LOCAL_MODELS)) {
    it(`${name} → ${info.uri}`, { timeout: 60_000 }, async () => {
      // eslint-disable-next-line no-restricted-syntax -- node-llama-cpp is an
      // optional, separately-installed dependency (see localModels.ts).
      const { createModelDownloader } = await import("node-llama-cpp");
      const downloader = await createModelDownloader({
        modelUri: info.uri,
        dirPath: dir,
        showCliProgress: false,
      });
      try {
        // Awaiting createModelDownloader already fetched the manifest (throws
        // on a bad/gated repo or an unresolvable quant tag) and computed the
        // total size — proof the URI is live and points at real files.
        expect(downloader.totalSize).toBeGreaterThan(0);
      } finally {
        await downloader.cancel({ deleteTempFile: true });
      }
    });
  }
});
