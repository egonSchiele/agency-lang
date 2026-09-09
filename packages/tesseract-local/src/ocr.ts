import { createWorker } from "tesseract.js";
import { wholePath, readBytes } from "agency-lang/stdlib-lib/contained.js";
import { ensureLanguage, resolveLanguageDir } from "./languageManager.js";
import type { LanguageName } from "./types.js";

/** Recognize the text in an image with tesseract.js. The image is read
 *  through a validated descriptor from agency-lang's contained module,
 *  which refuses a symlink at the final name and anything that is not a
 *  regular file, and the worker gets the bytes, never a path. There is
 *  no interrupt here, so there is no pre/post split; whisper-local
 *  raises none either. Language data is fetched once, verified against
 *  models.lock.json, and read from ~/.agency/models/tesseract after
 *  that. The worker never fetches: langPath is the local directory and
 *  caching is off. */
export async function readText(
  filepath: string,
  language: LanguageName = "eng",
): Promise<string> {
  if (!filepath) {
    throw new Error("readText: filepath is required");
  }
  const located = wholePath(filepath);
  const bytes = readBytes(located.root, located.target);
  await ensureLanguage(language);
  const worker = await createWorker(language, undefined, {
    langPath: resolveLanguageDir(),
    gzip: false,
    cacheMethod: "none",
  });
  try {
    const result = await worker.recognize(bytes);
    return result.data.text.trim();
  } finally {
    await worker.terminate();
  }
}
