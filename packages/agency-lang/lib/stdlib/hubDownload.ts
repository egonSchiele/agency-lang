import * as fs from "node:fs";
import * as path from "node:path";
import { root, resolveUnder, mkdir, stat, type Root } from "./contained.js";
import {
  readMlxModelRecord,
  writeMlxModelRecord,
  type MlxModelRecord,
  type MlxFileRecord,
} from "./mlxModelRecord.js";
import { fileSha256, verifyModelFile } from "./modelVerify.js";

/** Downloads a Hugging Face model repo with plain HTTP: the tree API for
 *  the file list and hashes, `resolve/` for a CDN URL per file, and byte
 *  ranges so a file downloads as parallel chunks and resumes at any chunk.
 *  This is the one stdlib file that writes through `fs`, because a chunk
 *  lands at a byte offset inside a file `contained.ts` has no primitive
 *  for. Every path still goes through `resolveUnder` first. */

export const DEFAULT_HUB_URL = "https://huggingface.co";
export const CHUNK_BYTES = 64 * 1024 * 1024;
export const DEFAULT_CONCURRENCY = 8;
const MAX_REDIRECTS = 5;
const RETRIES = 3;

export const GATED_MESSAGE =
  "This repo is gated. Set HF_TOKEN to a Hugging Face token that has accepted its terms.";

export type HubFile = { path: string; size: number; sha256?: string };
export type HubSnapshot = { repo: string; revision: string; files: HubFile[] };

export type HubOptions = {
  hubUrl?: string;
  token?: string;
  fetch?: typeof fetch;
  /** Tests run a fake hub over http. Nothing else sets this. */
  allowHttp?: boolean;
};

function hubUrlOf(options: HubOptions): string {
  const url = options.hubUrl ?? DEFAULT_HUB_URL;
  requireHttps(url, options);
  return url.replace(/\/+$/, "");
}

function requireHttps(url: string, options: HubOptions): void {
  if (options.allowHttp === true) {
    return;
  }
  if (!url.startsWith("https://")) {
    throw new Error(`Refusing to download over ${new URL(url).protocol.slice(0, -1)}: ${url}`);
  }
}

/** The token goes only to the hub host. A CDN URL is signed and takes none. */
function authHeaders(url: string, options: HubOptions): Record<string, string> {
  if (options.token === undefined || options.token === "") {
    return {};
  }
  const hub = new URL(hubUrlOf(options));
  return new URL(url).host === hub.host ? { authorization: `Bearer ${options.token}` } : {};
}

async function hubJson(
  url: string,
  options: HubOptions,
): Promise<{ body: unknown; link: string | null }> {
  const fetchFn = options.fetch ?? fetch;
  const res = await fetchFn(url, { headers: authHeaders(url, options) });
  if (res.status === 401 || res.status === 403) {
    throw new Error(GATED_MESSAGE);
  }
  if (!res.ok) {
    throw new Error(`${url} answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return { body: await res.json(), link: res.headers.get("link") };
}

type TreeEntry = { type: string; path: string; size: number; lfs?: { oid: string } };

/** Follows the `Link: <…>; rel="next"` header the tree API sends for a
 *  repo with more entries than one page holds. */
async function fetchTree(url: string, options: HubOptions): Promise<TreeEntry[]> {
  const out: TreeEntry[] = [];
  let next: string | null = url;
  while (next !== null) {
    const page = await hubJson(next, options);
    out.push(...(page.body as TreeEntry[]));
    const m = page.link?.match(/<([^>]+)>;\s*rel="next"/);
    next = m === undefined || m === null ? null : m[1];
  }
  return out;
}

/** The commit and the file list, with a size for every file and a sha256
 *  for every LFS file. `revision` defaults to `main`; a given one may be a
 *  short sha. Gated repos need `token`. */
export async function fetchHubSnapshot(
  repo: string,
  revision: string | undefined,
  options: HubOptions = {},
): Promise<HubSnapshot> {
  const hub = hubUrlOf(options);
  const modelUrl =
    revision === undefined
      ? `${hub}/api/models/${repo}`
      : `${hub}/api/models/${repo}/revision/${encodeURIComponent(revision)}`;
  const info = (await hubJson(modelUrl, options)).body as { sha: string; gated?: unknown };
  if (info.gated !== undefined && info.gated !== false && (options.token ?? "") === "") {
    throw new Error(GATED_MESSAGE);
  }
  const entries = await fetchTree(
    `${hub}/api/models/${repo}/tree/${info.sha}?recursive=true`,
    options,
  );
  const files: HubFile[] = entries
    .filter((e) => e.type === "file")
    .map((e) =>
      e.lfs === undefined
        ? { path: e.path, size: e.size }
        : { path: e.path, size: e.size, sha256: e.lfs.oid },
    );
  return { repo, revision: info.sha, files };
}

export type Chunk = { path: string; index: number; start: number; end: number };

/** Which chunks still need fetching: none for a complete file of the right
 *  size, and only the ones not yet recorded for a partial one. */
export function planChunks(
  snapshot: HubSnapshot,
  record: MlxModelRecord | null,
  chunkBytes: number = CHUNK_BYTES,
): Chunk[] {
  const out: Chunk[] = [];
  for (const file of snapshot.files) {
    const rec = record?.files[file.path];
    if (rec?.complete === true && rec.size === file.size) {
      continue;
    }
    const done = rec?.size === file.size ? (rec.chunks ?? []) : [];
    const count = Math.max(1, Math.ceil(file.size / chunkBytes));
    for (let i = 0; i < count; i++) {
      if (!done.includes(i)) {
        out.push({
          path: file.path,
          index: i,
          start: i * chunkBytes,
          end: Math.min(file.size, (i + 1) * chunkBytes),
        });
      }
    }
  }
  return out;
}

export type DownloadEvent =
  | { kind: "file-start"; path: string; size: number; resumedBytes: number }
  | { kind: "bytes"; done: number; total: number }
  | { kind: "file-done"; path: string }
  | { kind: "verify"; path: string; ok: boolean }
  | { kind: "adopt"; path: string };

export type DownloadOptions = HubOptions & {
  concurrency?: number;
  chunkBytes?: number;
  /** Base of the 1s, 2s, 4s retry waits. Tests shorten it. */
  retryDelayMs?: number;
  onEvent?: (e: DownloadEvent) => void;
};

function revisionMismatch(dir: string, snapshot: HubSnapshot, held: string): Error {
  return new Error(
    `${dir} holds revision ${held.slice(0, 7)}, but ${snapshot.repo} is now at ` +
      `${snapshot.revision.slice(0, 7)}. Remove it or pin the old revision with ` +
      `mlx:${snapshot.repo}@${held.slice(0, 7)}.`,
  );
}

/** The record to download against: the one on disk when it is for this
 *  revision, else a fresh one. A file already on disk with no record and
 *  the right hash is adopted rather than fetched again. */
async function startingRecord(
  r: Root,
  dir: string,
  snapshot: HubSnapshot,
  emit: (e: DownloadEvent) => void,
): Promise<MlxModelRecord> {
  const existing = readMlxModelRecord(dir);
  if (existing !== null && existing.revision !== snapshot.revision) {
    throw revisionMismatch(dir, snapshot, existing.revision);
  }
  const files: Record<string, MlxFileRecord> = {};
  for (const file of snapshot.files) {
    const kept = existing?.files[file.path];
    if (kept !== undefined && kept.size === file.size) {
      files[file.path] = kept;
      continue;
    }
    const entry: MlxFileRecord = { size: file.size, complete: false, chunks: [] };
    if (file.sha256 !== undefined) {
      entry.sha256 = file.sha256;
    }
    if (existing === null && (await matchesOnDisk(r, file))) {
      entry.complete = true;
      delete entry.chunks;
      emit({ kind: "adopt", path: file.path });
    }
    files[file.path] = entry;
  }
  return { repo: snapshot.repo, revision: snapshot.revision, files };
}

async function matchesOnDisk(r: Root, file: HubFile): Promise<boolean> {
  const info = stat(r, file.path);
  if (info === null || !info.isFile() || info.size !== file.size) {
    return false;
  }
  if (file.sha256 === undefined) {
    return true;
  }
  return (await fileSha256(resolveUnder(r, file.path))) === file.sha256.toLowerCase();
}

/** Follows `resolve/` to the CDN URL for one file. Each hop is resolved
 *  against the URL it came from, since the Hub sends relative locations,
 *  and each must be https. The walk stops at the first URL off the hub
 *  host: that is the signed CDN URL, and it is not requested here. */
async function resolveCdnUrl(
  snapshot: HubSnapshot,
  filePath: string,
  options: HubOptions,
): Promise<string> {
  const fetchFn = options.fetch ?? fetch;
  const hubHost = new URL(hubUrlOf(options)).host;
  let url = `${hubUrlOf(options)}/${snapshot.repo}/resolve/${snapshot.revision}/${filePath}`;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetchFn(url, {
      method: "HEAD",
      redirect: "manual",
      headers: authHeaders(url, options),
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error(GATED_MESSAGE);
    }
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location !== null) {
      url = new URL(location, url).toString();
      requireHttps(url, options);
      if (new URL(url).host !== hubHost) {
        return url;
      }
      continue;
    }
    if (res.ok) {
      return url;
    }
    throw new Error(`${url} answered ${res.status} while resolving ${filePath}`);
  }
  throw new Error(`Too many redirects while resolving ${filePath}`);
}

class Expired extends Error {}

async function fetchRange(
  url: string,
  chunk: Chunk,
  size: number,
  options: HubOptions,
  onBytes: (n: number) => void,
): Promise<Buffer> {
  const fetchFn = options.fetch ?? fetch;
  const res = await fetchFn(url, { headers: { range: `bytes=${chunk.start}-${chunk.end - 1}` } });
  if (res.status === 403) {
    throw new Expired(`${chunk.path}: the CDN URL was refused`);
  }
  if (res.status !== 206) {
    throw new Error(`${chunk.path}: expected 206 for a byte range, got ${res.status}`);
  }
  const total = res.headers.get("content-range")?.split("/")[1];
  if (total !== String(size)) {
    throw new Error(
      `${chunk.path}: the server reports ${total ?? "no"} bytes, the tree said ${size}`,
    );
  }
  const buf = await readBody(res, onBytes);
  if (buf.length !== chunk.end - chunk.start) {
    throw new Error(
      `${chunk.path}: got ${buf.length} bytes for a ${chunk.end - chunk.start}-byte range`,
    );
  }
  return buf;
}

/** The body as one buffer, reporting each piece as it arrives so the
 *  counter moves inside a chunk, not only between chunks. */
async function readBody(res: Response, onBytes: (n: number) => void): Promise<Buffer> {
  if (res.body === null) {
    return Buffer.alloc(0);
  }
  const pieces: Buffer[] = [];
  for await (const piece of res.body as unknown as AsyncIterable<Uint8Array>) {
    pieces.push(Buffer.from(piece));
    onBytes(piece.length);
  }
  return Buffer.concat(pieces);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One descriptor per file being written, opened for read-write at any
 *  offset, under the root. */
class OpenFiles {
  private descriptors: Record<string, number> = {};

  constructor(private readonly root: Root) {}

  open(filePath: string): number {
    if (this.descriptors[filePath] === undefined) {
      const resolved = resolveUnder(this.root, filePath);
      mkdir(this.root, path.dirname(filePath));
      this.descriptors[filePath] = fs.openSync(
        resolved,
        fs.constants.O_RDWR | fs.constants.O_CREAT,
        0o644,
      );
    }
    return this.descriptors[filePath];
  }

  close(filePath: string): void {
    if (this.descriptors[filePath] !== undefined) {
      fs.closeSync(this.descriptors[filePath]);
      delete this.descriptors[filePath];
    }
  }

  closeAll(): void {
    for (const filePath of Object.keys(this.descriptors)) {
      this.close(filePath);
    }
  }
}

/** Emits `file-start` once per file in the plan and returns how many
 *  chunks each file still needs. */
function announceFiles(
  plan: Chunk[],
  record: MlxModelRecord,
  chunkBytes: number,
  emit: (e: DownloadEvent) => void,
): Record<string, number> {
  const remaining: Record<string, number> = {};
  for (const chunk of plan) {
    if (remaining[chunk.path] === undefined) {
      remaining[chunk.path] = 0;
      const entry = record.files[chunk.path];
      emit({
        kind: "file-start",
        path: chunk.path,
        size: entry.size,
        resumedBytes: (entry.chunks ?? []).length * chunkBytes,
      });
    }
    remaining[chunk.path] += 1;
  }
  return remaining;
}

/** Downloads every chunk the record says is missing into `dir`, verifies
 *  each file as it completes, and returns `dir`. Running it again after an
 *  interruption fetches only what is missing. */
export async function downloadHubSnapshot(
  snapshot: HubSnapshot,
  dir: string,
  options: DownloadOptions = {},
): Promise<string> {
  const emit = options.onEvent ?? (() => {});
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const retryDelay = options.retryDelayMs ?? 1000;
  const r = root(dir);
  mkdir(r, ".");
  const record = await startingRecord(r, dir, snapshot, emit);
  writeMlxModelRecord(dir, record);
  const plan = planChunks(snapshot, record, options.chunkBytes);
  const sizes: Record<string, number> = {};
  for (const file of snapshot.files) {
    sizes[file.path] = file.size;
  }

  const total = snapshot.files.reduce((sum, f) => sum + f.size, 0);
  let done = total - plan.reduce((sum, c) => sum + (c.end - c.start), 0);
  let inFlight = 0;
  let lastBytesEvent = 0;
  const progress = (force: boolean) => {
    const now = Date.now();
    if (force || now - lastBytesEvent >= 500) {
      lastBytesEvent = now;
      emit({ kind: "bytes", done: done + inFlight, total });
    }
  };

  const files = new OpenFiles(r);
  const remaining = announceFiles(plan, record, options.chunkBytes ?? CHUNK_BYTES, emit);

  // One resolve per file, even when several workers start on it at once.
  const cdnUrls: Record<string, Promise<string>> = {};
  const cdnUrl = (filePath: string): Promise<string> => {
    if (cdnUrls[filePath] === undefined) {
      cdnUrls[filePath] = resolveCdnUrl(snapshot, filePath, options);
    }
    return cdnUrls[filePath];
  };

  const fetchChunk = async (chunk: Chunk): Promise<Buffer> => {
    let lastError: Error = new Error("no attempt");
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      let received = 0;
      const onBytes = (n: number) => {
        received += n;
        inFlight += n;
        progress(false);
      };
      try {
        return await fetchRange(
          await cdnUrl(chunk.path),
          chunk,
          sizes[chunk.path],
          options,
          onBytes,
        );
      } catch (err) {
        // A failed attempt's bytes are not on disk; count them out again.
        inFlight -= received;
        lastError = err as Error;
        if (err instanceof Expired) {
          // A signed URL past its window: resolve it again, once.
          delete cdnUrls[chunk.path];
          continue;
        }
        await sleep(retryDelay * 2 ** attempt);
      }
    }
    throw lastError;
  };

  const finishFile = async (filePath: string): Promise<void> => {
    files.close(filePath);
    const resolved = resolveUnder(r, filePath);
    const entry = record.files[filePath];
    try {
      if (entry.sha256 !== undefined) {
        await verifyModelFile(resolved, entry.sha256, filePath);
      } else if (fs.statSync(resolved).size !== entry.size) {
        throw new Error(
          `${filePath} is ${fs.statSync(resolved).size} bytes, expected ${entry.size}`,
        );
      }
    } catch (err) {
      // The file was moved aside or is wrong: the next run fetches it whole.
      record.files[filePath] = { ...entry, complete: false, chunks: [] };
      writeMlxModelRecord(dir, record);
      emit({ kind: "verify", path: filePath, ok: false });
      throw err;
    }
    entry.complete = true;
    delete entry.chunks;
    writeMlxModelRecord(dir, record);
    emit({ kind: "file-done", path: filePath });
    emit({ kind: "verify", path: filePath, ok: true });
  };

  let next = 0;
  let failed: Error | null = null;
  const worker = async (): Promise<void> => {
    while (failed === null && next < plan.length) {
      const chunk = plan[next++];
      try {
        const buf = await fetchChunk(chunk);
        fs.writeSync(files.open(chunk.path), buf, 0, buf.length, chunk.start);
        const entry = record.files[chunk.path];
        entry.chunks = [...(entry.chunks ?? []), chunk.index];
        writeMlxModelRecord(dir, record);
        inFlight -= buf.length;
        done += buf.length;
        progress(false);
        remaining[chunk.path] -= 1;
        if (remaining[chunk.path] === 0) {
          await finishFile(chunk.path);
        }
      } catch (err) {
        failed = err as Error;
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  } finally {
    files.closeAll();
  }
  if (failed !== null) {
    throw failed;
  }
  progress(true);
  return dir;
}
