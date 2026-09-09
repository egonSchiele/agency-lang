import * as fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
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

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = [301, 302, 303, 307, 308];

/** Fetch with redirects followed by hand, so every hop is checked
 *  against the scheme rule before a request is made to it. fetch's own
 *  redirect following would issue the plaintext request first and only
 *  let us inspect the final URL afterwards. */
async function fetchOverAllowedSchemes(url: string): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isAllowedScheme(current)) {
      throw new LanguageManagerError(
        `refusing to download language data over non-HTTPS URL: ${current}`,
      );
    }
    const response = await fetch(current, { redirect: "manual" });
    if (!REDIRECT_STATUSES.includes(response.status)) {
      return response;
    }
    const location = response.headers.get("location");
    if (location === null) {
      throw new LanguageManagerError(
        `redirect from ${current} carried no Location header`,
      );
    }
    current = new URL(location, current).toString();
  }
  throw new LanguageManagerError(
    `too many redirects downloading language data from ${url}`,
  );
}

/** A pass-through that fails once more than `limit` bytes have gone by,
 *  so a misbehaving endpoint cannot fill the disk before the hash check. */
function byteLimiter(limit: number, url: string): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.length;
      if (seen > limit) {
        callback(
          new LanguageManagerError(
            `download from ${url} exceeded the pinned size of ${limit} bytes`,
          ),
        );
        return;
      }
      callback(null, chunk);
    },
  });
}

/** Download one lockfile entry to `dest`. The bytes land in a partial
 *  file unique to this call, are capped at the pinned size, hashed with
 *  agency-lang's own verifier, and renamed into place only when the size
 *  and hash match. Any failure deletes the partial. Two callers racing
 *  on the same language each verify their own partial; the rename is
 *  atomic and both files are identical, so the second rename is harmless. */
export async function downloadLanguage(
  entry: LockfileEntry,
  dest: string,
): Promise<void> {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const partial = `${dest}.${randomUUID()}.partial`;

  try {
    const response = await fetchOverAllowedSchemes(entry.url);
    if (!response.ok || !response.body) {
      throw new LanguageManagerError(
        `failed to download language data from ${entry.url}: HTTP ${response.status}`,
      );
    }
    await pipeline(
      Readable.fromWeb(response.body as WebReadableStream),
      byteLimiter(entry.sizeBytes, entry.url),
      createWriteStream(partial, { flags: "wx" }),
    );

    const { size } = await fs.stat(partial);
    if (size !== entry.sizeBytes) {
      throw new LanguageManagerError(
        `download from ${entry.url} is ${size} bytes; the lockfile pins ${entry.sizeBytes}`,
      );
    }
    const actual = await fileSha256(partial);
    if (actual !== entry.sha256) {
      throw new LanguageManagerError(
        `SHA-256 mismatch (expected ${entry.sha256}, got ${actual}). ` +
          `The downloaded file has been deleted. This may indicate a corrupted ` +
          `download or compromised mirror.`,
      );
    }
    await fs.rename(partial, dest);
  } catch (err) {
    await fs.rm(partial, { force: true });
    throw err;
  }
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
