import * as fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { fileSha256 } from "agency-lang/stdlib-lib/modelVerify.js";
import type { LanguageName, Lockfile, LockfileEntry } from "./types.js";
import { KNOWN_LANGUAGES } from "./types.js";
import { findPackageRoot } from "./packageRoot.js";

export class LanguageManagerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LanguageManagerError";
  }
}

export function resolveLanguageDir(): string {
  const override = process.env.AGENCY_TESSERACT_MODELS_DIR;
  if (override) return override;
  return path.join(os.homedir(), ".agency/models/tesseract");
}

export function resolveLanguagePath(
  name: LanguageName,
  dir: string = resolveLanguageDir(),
): string {
  if (!KNOWN_LANGUAGES.includes(name)) {
    throw new LanguageManagerError(
      `unknown language "${name}". Choices: ${KNOWN_LANGUAGES.join(", ")}`,
    );
  }
  return path.join(dir, `${name}.traineddata`);
}

export async function isLanguageInstalled(
  name: LanguageName,
  dir: string = resolveLanguageDir(),
): Promise<boolean> {
  const p = resolveLanguagePath(name, dir);
  try {
    const st = await fs.stat(p);
    return st.isFile();
  } catch {
    return false;
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PACKAGE_ROOT = findPackageRoot(__dirname);

/** Parse and validate lockfile text. Separate from loadLockfile so the
 *  schema-rejection branch is testable without touching PACKAGE_ROOT. */
export function parseLockfile(text: string, source = "<inline>"): Lockfile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new LanguageManagerError(
      `failed to parse ${source}: ${(err as Error).message}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new LanguageManagerError(`${source} is not a JSON object`);
  }
  const schemaVersion = (parsed as { schemaVersion?: unknown }).schemaVersion;
  if (schemaVersion !== 1) {
    throw new LanguageManagerError(
      `unsupported lockfile schema version ${String(schemaVersion)} in ${source}`,
    );
  }
  const languages = (parsed as { languages?: unknown }).languages;
  if (
    typeof languages !== "object" ||
    languages === null ||
    Array.isArray(languages)
  ) {
    throw new LanguageManagerError(`${source} is missing a 'languages' object`);
  }
  return parsed as Lockfile;
}

export async function loadLockfile(): Promise<Lockfile> {
  const lockPath = path.join(PACKAGE_ROOT, "models.lock.json");
  const text = await fs.readFile(lockPath, "utf8");
  return parseLockfile(text, lockPath);
}

function isAllowedScheme(url: string): boolean {
  // Allow https everywhere; allow http only for localhost test fixtures.
  if (url.startsWith("https://")) return true;
  return /^http:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(url);
}

/** Download one lockfile entry to `dest`. The file lands in a `.partial`
 *  beside it, is hashed with agency-lang's own verifier, and is renamed
 *  into place only when the hash matches. A mismatch deletes the partial.
 *  Same rules as whisper-local: HTTPS only, and the final URL after
 *  redirects is checked again. */
export async function downloadLanguage(
  entry: LockfileEntry,
  dest: string,
): Promise<void> {
  if (!isAllowedScheme(entry.url)) {
    throw new LanguageManagerError(
      `refusing to download language data over non-HTTPS URL: ${entry.url}`,
    );
  }

  await fs.mkdir(path.dirname(dest), { recursive: true });
  const partial = `${dest}.partial`;
  await fs.rm(partial, { force: true });

  const response = await fetch(entry.url);
  if (!response.ok || !response.body) {
    throw new LanguageManagerError(
      `failed to download language data from ${entry.url}: HTTP ${response.status}`,
    );
  }
  if (response.url && !isAllowedScheme(response.url)) {
    throw new LanguageManagerError(
      `refusing to follow redirect to non-HTTPS URL: ${response.url} (started from ${entry.url})`,
    );
  }

  const out = createWriteStream(partial);
  const closeStream = (err?: Error): Promise<void> =>
    new Promise<void>((resolve) => {
      if (out.closed || out.destroyed) {
        resolve();
        return;
      }
      out.once("close", () => resolve());
      out.destroy(err);
    });

  try {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!out.write(value)) {
        await new Promise<void>((resolve) =>
          out.once("drain", () => resolve()),
        );
      }
    }
    await new Promise<void>((resolve, reject) => {
      out.end((err: unknown) => (err ? reject(err) : resolve()));
    });
  } catch (err) {
    await closeStream(err as Error);
    await fs.rm(partial, { force: true });
    throw err;
  }

  const actual = await fileSha256(partial);
  if (actual !== entry.sha256) {
    await fs.rm(partial, { force: true });
    throw new LanguageManagerError(
      `SHA-256 mismatch (expected ${entry.sha256}, got ${actual}). ` +
        `The downloaded file has been deleted. This may indicate a corrupted ` +
        `download or compromised mirror.`,
    );
  }

  await fs.rename(partial, dest);
}

export async function ensureLanguage(
  name: LanguageName,
  dir: string = resolveLanguageDir(),
): Promise<string> {
  const target = resolveLanguagePath(name, dir);
  if (await isLanguageInstalled(name, dir)) return target;
  const lock = await loadLockfile();
  const entry = lock.languages[name];
  if (!entry) {
    throw new LanguageManagerError(`no lockfile entry for language "${name}"`);
  }
  if (process.stderr.isTTY) {
    process.stderr.write(
      `Downloading ${name} language data (~${Math.round(entry.sizeBytes / 1e6)} MB) ...\n`,
    );
  }
  await downloadLanguage(entry, target);
  return target;
}
