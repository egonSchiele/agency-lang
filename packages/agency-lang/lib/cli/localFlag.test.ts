import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import * as smoltalkPkg from "smoltalk";
import { resolveLocalRunFlag } from "./localFlag.js";
import { hasLocalModelSupport } from "../stdlib/localModels.js";

const here = path.dirname(fileURLToPath(import.meta.url));

// ONE fake for the whole file: smoltalk's loadLlamaCpp caches the loaded
// module per process (first load wins), so per-test fakes with different
// behavior would silently all resolve to whichever loaded first. The echo
// shape (resolveModel returns its input) serves every case here.
const fakePlugin = path.join(here, `__tmp_fake_flag_${process.pid}.mjs`);

function writeFakePlugin(): string {
  fs.writeFileSync(
    fakePlugin,
    `import { BaseClient } from "smoltalk";
export class LlamaCPP extends BaseClient {}
export async function resolveModel(target, dir) { return target; }
`,
  );
  return fakePlugin;
}

afterEach(() => {
  delete process.env.AGENCY_LLAMA_PROVIDER_MODULE;
  smoltalkPkg.unregisterProvider("llama-cpp");
  try {
    fs.unlinkSync(fakePlugin);
  } catch {
    /* ignore */
  }
});

describe("resolveLocalRunFlag", () => {
  it("resolves through the plugin and pins the llama-cpp provider", async () => {
    process.env.AGENCY_LLAMA_PROVIDER_MODULE = writeFakePlugin();
    const flag = await resolveLocalRunFlag("./some-model.gguf");
    expect(flag).toEqual({
      model: path.resolve(process.cwd(), "./some-model.gguf"),
      explicitProvider: "llama-cpp",
    });
    expect(smoltalkPkg.hasProvider("llama-cpp")).toBe(true);
  });

  it("absolutizes the resolved path (LlamaCPP rejects bare filenames)", async () => {
    process.env.AGENCY_LLAMA_PROVIDER_MODULE = writeFakePlugin();
    // A bare separator-less filename is what `--local model.gguf` arrives as.
    const flag = await resolveLocalRunFlag("model.gguf");
    expect(flag.model).toBe(path.resolve(process.cwd(), "model.gguf"));
    expect(path.isAbsolute(flag.model)).toBe(true);
    expect(flag.explicitProvider).toBe("llama-cpp");
  });

  it("propagates the install-hint error when support is missing", async () => {
    // No override; rely on smoltalk-llama-cpp not being installed in CI.
    // Skip on dev machines that have it resolvable.
    if (hasLocalModelSupport()) return;
    await expect(resolveLocalRunFlag("qwen3.5-0.8b")).rejects.toThrow(
      /smoltalk-llama-cpp/,
    );
  });
});
