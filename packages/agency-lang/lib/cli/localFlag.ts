import * as path from "node:path";
import type { ResolvedModelFlag } from "@/config.js";
import { _registerLocalModel } from "@/stdlib/localModels.js";

/** Turn `agency run --local <value>` into the shared model-flag shape:
 *  resolve the name (curated / alias / hf: URI / .gguf path), download and
 *  verify if needed (progress prints here, in the parent, before the program
 *  starts), and pin the llama-cpp provider. Errors (package missing, unknown
 *  name, failed download) carry user-ready messages from localModels.
 *
 *  The path is absolutized before it is baked into config: LlamaCPP rejects a
 *  bare separator-less filename (ambiguous with a model name), which is what
 *  a user-supplied `--local model.gguf` would otherwise arrive as, and an
 *  absolute path also keeps the child process independent of cwd drift. */
export async function resolveLocalRunFlag(value: string): Promise<ResolvedModelFlag> {
  const modelPath = await _registerLocalModel(value);
  return { model: path.resolve(modelPath), explicitProvider: "llama-cpp" };
}
