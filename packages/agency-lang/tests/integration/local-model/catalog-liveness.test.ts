import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CURATED_LOCAL_MODELS } from "../../../lib/stdlib/localModels.js";
import { HubClient } from "../../../lib/stdlib/hubClient.js";
import { parseMlxUri } from "../../../lib/stdlib/modelBackend.js";
import type { ModelInfo } from "../../../lib/stdlib/modelCatalog.js";

// Catalog liveness: assert every curated short name's Hugging Face URI still
// resolves to real, downloadable files — WITHOUT downloading any weights.
// This is the guard that would have caught the dead `HuggingFaceTB/...` and
// `bartowski/...` URIs before a user hit them.
//
// llama-cpp entries go through `createModelDownloader()`, which fetches the
// HF manifest (and 401s/404s on a wrong or gated repo, or throws if the
// `:quant` tag matches no file) and computes the total size; we never call
// `.download()`. mlx entries go through the same Hub metadata calls the
// downloader makes (`HubClient.fetchSnapshot`): the repo must hold a
// `config.json` and at least one weights shard, which is what `isModelDir`
// demands of the download once it lands.
//
// Gated on AGENCY_LLM_INTEGRATION=1 (network required); runs post-merge via
// .github/workflows/local-model.yml. Lightweight — manifest fetches only, no
// GB downloads. No HF_TOKEN needed: every curated repo is public and ungated,
// and must stay so, because a user without a token has to be able to
// download it too.
const enabled = process.env.AGENCY_LLM_INTEGRATION === "1";

// The Hub's per-file sizes are exact; `sizeBytes` is rounded to a few
// significant figures. Anything further off than this means the repo was
// re-quantized or re-sharded under the same name.
const SIZE_TOLERANCE = 0.05;

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

async function checkLlamaCpp(info: ModelInfo): Promise<void> {
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
}

async function checkMlx(info: ModelInfo): Promise<void> {
  const { repo, revision } = parseMlxUri(info.uri);
  const snapshot = await new HubClient().fetchSnapshot(repo, revision);
  const names = snapshot.files.map((f) => f.path);
  expect(names).toContain("config.json");
  expect(names.some((n) => n.endsWith(".safetensors"))).toBe(true);
  const total = snapshot.files.reduce((sum, f) => sum + f.size, 0);
  expect(Math.abs(total - info.sizeBytes) / info.sizeBytes).toBeLessThan(SIZE_TOLERANCE);
}

describe.runIf(enabled)("curated catalog liveness (HF manifest resolves; no weights)", () => {
  for (const [name, info] of Object.entries(CURATED_LOCAL_MODELS)) {
    it(`${name} → ${info.uri}`, { timeout: 60_000 }, async () => {
      if (info.backend === "mlx") {
        await checkMlx(info);
      } else {
        await checkLlamaCpp(info);
      }
    });
  }
});
