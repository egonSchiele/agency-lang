import * as fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ModelName, Lockfile, LockfileEntry } from "./types.js";
import { KNOWN_MODELS } from "./types.js";
import { findPackageRoot } from "./packageRoot.js";

export class ModelManagerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelManagerError";
  }
}

export function resolveModelDir(): string {
  const override = process.env.AGENCY_WHISPER_MODELS_DIR;
  if (override) return override;
  return path.join(os.homedir(), ".agency/models/whisper");
}

export function resolveModelPath(
  name: ModelName,
  dir: string = resolveModelDir(),
): string {
  if (!KNOWN_MODELS.includes(name)) {
    throw new ModelManagerError(
      `unknown model "${name}". Choices: ${KNOWN_MODELS.join(", ")}`,
    );
  }
  return path.join(dir, `ggml-${name}.bin`);
}

export async function isModelInstalled(
  name: ModelName,
  dir: string = resolveModelDir(),
): Promise<boolean> {
  const p = resolveModelPath(name, dir);
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

// Parse + validate lockfile text. Pulled out from loadLockfile so the
// schema-rejection branch is testable without writing to PACKAGE_ROOT.
export function parseLockfile(text: string, source = "<inline>"): Lockfile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ModelManagerError(
      `failed to parse ${source}: ${(err as Error).message}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new ModelManagerError(`${source} is not a JSON object`);
  }
  const schemaVersion = (parsed as { schemaVersion?: unknown }).schemaVersion;
  if (schemaVersion !== 1) {
    throw new ModelManagerError(
      `unsupported lockfile schema version ${String(schemaVersion)} in ${source}`,
    );
  }
  return parsed as Lockfile;
}

export async function loadLockfile(): Promise<Lockfile> {
  const lockPath = path.join(PACKAGE_ROOT, "models.lock.json");
  const text = await fs.readFile(lockPath, "utf8");
  return parseLockfile(text, lockPath);
}

export async function sha256OfFile(filepath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  const fd = await fs.open(filepath, "r");
  try {
    const stream = fd.createReadStream();
    for await (const chunk of stream) hash.update(chunk as Buffer);
  } finally {
    await fd.close();
  }
  return hash.digest("hex");
}

function isAllowedScheme(url: string): boolean {
  // Allow https everywhere; allow http only for localhost test fixtures.
  if (url.startsWith("https://")) return true;
  return /^http:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(url);
}

export async function downloadModel(
  entry: LockfileEntry,
  dest: string,
): Promise<void> {
  // Defense in depth: even though the lockfile is committed and reviewed, refuse
  // to fetch over plaintext. The SHA-256 check below would still catch tampering,
  // but rejecting non-HTTPS up front avoids exposing the user's network to a
  // downgrade attack and makes lockfile-tampering review easier.
  // Allow http://127.0.0.1 and http://localhost for tests.
  if (!isAllowedScheme(entry.url)) {
    throw new ModelManagerError(
      `refusing to download model over non-HTTPS URL: ${entry.url}`,
    );
  }

  await fs.mkdir(path.dirname(dest), { recursive: true });
  const partial = `${dest}.partial`;

  // Clean any leftover partial from a prior failed attempt.
  await fs.rm(partial, { force: true });

  const response = await fetch(entry.url);
  if (!response.ok || !response.body) {
    throw new ModelManagerError(
      `failed to download model from ${entry.url}: HTTP ${response.status}`,
    );
  }

  // fetch() follows redirects by default. Re-check the *final* URL's scheme
  // so a compromised endpoint can't downgrade us from https to http.
  if (response.url && !isAllowedScheme(response.url)) {
    throw new ModelManagerError(
      `refusing to follow redirect to non-HTTPS URL: ${response.url} (started from ${entry.url})`,
    );
  }

  const hash = crypto.createHash("sha256");
  const out = createWriteStream(partial);

  // Helper: close the WriteStream cleanly before unlinking the partial file.
  // On Windows an open handle can prevent fs.rm from deleting the file.
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
      hash.update(value);
      if (!out.write(value)) {
        await new Promise<void>((resolve) => out.once("drain", () => resolve()));
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

  const actual = hash.digest("hex");
  if (actual !== entry.sha256) {
    await fs.rm(partial, { force: true });
    throw new ModelManagerError(
      `SHA-256 mismatch (expected ${entry.sha256}, got ${actual}). ` +
        `The downloaded file has been deleted. This may indicate a corrupted ` +
        `download or compromised mirror.`,
    );
  }

  await fs.rename(partial, dest);
}

export async function ensureModel(
  name: ModelName,
  dir: string = resolveModelDir(),
): Promise<string> {
  const target = resolveModelPath(name, dir);
  if (await isModelInstalled(name, dir)) return target;
  const lock = await loadLockfile();
  const entry = lock.models[name];
  if (!entry) {
    throw new ModelManagerError(`no lockfile entry for model "${name}"`);
  }
  // Defensive: refuse to "download" a placeholder. KNOWN_MODELS is kept in
  // sync with models.lock.json so this branch should be unreachable in
  // shipped code; it stays as belt-and-suspenders against a future regression
  // where a placeholder slips back into the lockfile.
  if (entry.sha256 === "0".repeat(64)) {
    throw new ModelManagerError(
      `model "${name}" has a placeholder hash in models.lock.json. ` +
        `The lockfile has not been populated yet (this is a setup bug).`,
    );
  }
  if (process.stderr.isTTY) {
    process.stderr.write(
      `Downloading ${name} (~${Math.round(entry.sizeBytes / 1e6)} MB) ...\n`,
    );
  }
  await downloadModel(entry, target);
  return target;
}
