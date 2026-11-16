/** Agency downloads each GGUF model into a folder of its own under
 *  `<modelsDir>/gguf/`, named after the URI it came from. Plain string
 *  functions, with no file access, so the runtime can name a model's
 *  folder without loading the downloader. */

export const GGUF_SUBDIR = "gguf";

/** Whether a llama-cpp target is something to download (an `hf:` or web
 *  URI) rather than a `.gguf` file already on disk. */
export function isGgufDownloadUri(target: string): boolean {
  return /^(hf:|https?:\/\/)/.test(target);
}

/** The folder name for a download URI. `hf:unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M`
 *  becomes `unsloth--Qwen3.8-27B-GGUF--UD-Q4_K_M`. Anything that is not a
 *  letter, digit, `.`, `_` or `-` becomes `--`, so the name never holds a
 *  path separator. Two URIs that differ only in those characters share a
 *  name; the record in the folder says which URI it holds. */
export function ggufModelDirName(uri: string): string {
  return uri.replace(/^hf:/, "").replace(/[^A-Za-z0-9._-]+/g, "--");
}

/** Whether `filePath` is a file inside the folder this URI downloads into. */
export function isInGgufModelDir(filePath: string, uri: string): boolean {
  const parts = filePath.split("/");
  return (
    parts.length >= 3 &&
    parts[parts.length - 3] === GGUF_SUBDIR &&
    parts[parts.length - 2] === ggufModelDirName(uri)
  );
}
