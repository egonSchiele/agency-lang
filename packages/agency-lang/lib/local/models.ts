import * as path from "node:path";
import {
  _listDownloadedModels,
  readModelAliases,
  aliasUri,
  type AliasValue,
  type DownloadedModel,
  type ModelKind,
} from "../stdlib/localModels.js";
import {
  hubSnapshotDir,
  isServedUri,
  parseServedUri,
  readModelJson,
  type Backend,
} from "../stdlib/modelBackend.js";

/** One model downloaded to this machine.
 *
 *  name       the name `serve` and the call functions take
 *  aliases    every alias in `agency.json` that points at this model
 *  kind       what the model is, when its record, the catalog, or its
 *             files say
 *  family     the class named in the model's `model_index.json`, such as
 *             "ZImagePipeline", or the first entry of `architectures` in
 *             its `config.json`, such as "Florence2ForConditionalGeneration"
 *  directory  the folder holding the model's files. For a Hugging Face
 *             cache entry, the snapshot folder
 *  complete   false for a download that was interrupted
 *  revision   the commit the model was downloaded from, when known */
export type LocalModel = {
  name: string;
  aliases: LocalModelAlias[];
  kind: ModelKind | null;
  family: string | null;
  backend: Backend;
  directory: string;
  sizeBytes: number;
  complete: boolean;
  revision: string | null;
};

export type LocalModelAlias = { name: string; description: string };

/** The snapshot folder of a Hugging Face cache folder, or `dir` itself for
 *  any other folder. A cache folder that cannot be read as one, such as
 *  one with several snapshots and no ref, is reported and left as it is. */
function modelDirectory(dir: string): string {
  try {
    return hubSnapshotDir(dir) ?? dir;
  } catch (err) {
    console.error(`agency-lang/local: ${(err as Error).message}`);
    return dir;
  }
}

function familyOf(directory: string): string | null {
  const className = readModelJson(directory, "model_index.json")?._class_name;
  if (typeof className === "string") {
    return className;
  }
  const architectures = readModelJson(directory, "config.json")?.architectures;
  const first = Array.isArray(architectures) ? architectures[0] : undefined;
  return typeof first === "string" ? first : null;
}

/** Whether an alias's target is this model: a served URI that names its
 *  backend and repo, or a path that is its file or folder. A URI pinned to
 *  a revision, `mlx:org/repo@abc123`, matches only the download at that
 *  revision. The pin may be the start of the commit, as it may anywhere
 *  else a revision is written. */
function aliasPointsAt(target: string, model: DownloadedModel, directory: string): boolean {
  if (isServedUri(target)) {
    const { backend, repo, revision } = parseServedUri(target);
    const sameRevision = revision === undefined || (model.revision ?? "").startsWith(revision);
    return backend === model.backend && repo === model.name && sameRevision;
  }
  const resolved = path.resolve(target);
  return [model.path, directory].includes(resolved) || modelDirectory(resolved) === directory;
}

function aliasesOf(
  model: DownloadedModel,
  directory: string,
  aliases: Record<string, AliasValue>,
): LocalModelAlias[] {
  return Object.entries(aliases)
    .filter(([, value]) => aliasPointsAt(aliasUri(value), model, directory))
    .map(([name, value]) => ({
      name,
      description: typeof value === "string" ? "" : (value.description ?? ""),
    }));
}

/** Every model downloaded to this machine. `agency local list` prints
 *  these and also the catalog's models that are not downloaded, which this
 *  leaves out.
 *
 *  Some entries are listed but cannot be served: a GGUF file (the backend
 *  `llama-cpp`), a ControlNet (the kind `controlnet`), and a download that
 *  is not complete. `serve` and the call functions take the `name` of
 *  every other entry. */
export function listModels(): LocalModel[] {
  const aliases = readModelAliases();
  return _listDownloadedModels().map((model) => {
    const directory = modelDirectory(model.path);
    return {
      name: model.name,
      aliases: aliasesOf(model, directory, aliases),
      kind: model.kind ?? null,
      family: familyOf(directory),
      backend: model.backend,
      directory,
      sizeBytes: model.sizeBytes,
      complete: model.complete,
      revision: model.revision ?? null,
    };
  });
}
