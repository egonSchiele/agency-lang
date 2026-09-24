import * as path from "node:path";
import type { ResolvedModelFlag } from "@/config/config.js";
import { _registerLocalModel, _resolveModel, _mlxServedName } from "@/stdlib/localModels.js";

/** Turn `agency run --local <value>` into the shared model-flag shape:
 *  resolve the name, and for a GGUF model download and verify if needed
 *  (progress prints here, in the parent, before the program starts) and pin
 *  the llama-cpp provider. An MLX model pins the mlx provider and the name
 *  the running server knows it by. Errors (package missing, unknown
 *  name, failed download) carry user-ready messages from localModels.
 *
 *  The path is absolutized before it is baked into config: LlamaCPP rejects a
 *  bare separator-less filename (ambiguous with a model name), which is what
 *  a user-supplied `--local model.gguf` would otherwise arrive as, and an
 *  absolute path also keeps the child process independent of cwd drift. */
export async function resolveLocalRunFlag(
  value: string,
  draft?: string,
): Promise<ResolvedModelFlag> {
  const resolved = _resolveModel(value);
  if (resolved.backend === "mlx") {
    if (draft !== undefined) {
      // The server owns speculative decoding for an MLX model; a run cannot
      // add a draft to a server that is already up.
      throw new Error(
        `${value} runs on the MLX server, which drafts for itself. Start it with: agency local serve ${value} --draft ${draft}`,
      );
    }
    // The user has already started mlx_lm.server on this model.
    // Nothing to download or register.
    return { model: _mlxServedName(resolved), explicitProvider: "mlx" };
  }
  const modelPath = await _registerLocalModel(value);
  const flag: ResolvedModelFlag = {
    model: path.resolve(modelPath),
    explicitProvider: "llama-cpp",
  };
  if (draft === undefined) {
    return flag;
  }
  const draftResolved = _resolveModel(draft);
  if (draftResolved.backend === "mlx") {
    throw new Error(`${draft} is an MLX model; a draft for a GGUF model must be a GGUF model too.`);
  }
  const draftPath = await _registerLocalModel(draft);
  return { ...flag, draftModel: path.resolve(draftPath) };
}
