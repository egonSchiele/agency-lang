import * as path from "node:path";
import {
  root,
  resolveUnder,
  mkdir,
  stat,
  writeBytes,
  openForWrite,
  type Root,
  type WritableFile,
} from "./contained.js";
import {
  readMlxModelRecord,
  writeMlxModelRecord,
  type MlxModelRecord,
  type MlxFileRecord,
} from "./mlxModelRecord.js";
import { fileSha256, verifyModelFile } from "./modelVerify.js";
import {
  HubClient,
  Expired,
  type Chunk,
  type HubFile,
  type HubOptions,
  type HubSnapshot,
} from "./hubClient.js";

export {
  DEFAULT_HUB_URL,
  GATED_MESSAGE,
  fetchHubSnapshot,
  type Chunk,
  type HubFile,
  type HubOptions,
  type HubSnapshot,
} from "./hubClient.js";

/** Downloads a Hugging Face model repo as parallel byte ranges into a
 *  directory that mlx-lm can load as it is. The repo's files land under
 *  their own names; `.agency-model.json` beside them records which
 *  chunks are on disk, so a second run fetches only what is missing. */

export const CHUNK_BYTES = 64 * 1024 * 1024;
export const DEFAULT_CONCURRENCY = 8;
/** Attempts per chunk before the run fails. The waits between them
 *  double from `retryDelayMs`. */
export const RETRIES = 5;

export type DownloadEvent =
  | { kind: "file-start"; path: string; size: number; resumedBytes: number }
  | { kind: "bytes"; done: number; total: number }
  | { kind: "file-done"; path: string }
  | { kind: "verify"; path: string; ok: boolean }
  | { kind: "adopt"; path: string };

export type DownloadOptions = HubOptions & {
  concurrency?: number;
  chunkBytes?: number;
  /** Base of the 1s, 2s, 4s… retry waits. Tests shorten it. */
  retryDelayMs?: number;
  onEvent?: (e: DownloadEvent) => void;
};

type Emit = (e: DownloadEvent) => void;

/** Which chunks still need fetching: none for a complete file of the
 *  right size, only the unrecorded ones for a partial file, and none for
 *  an empty file, which the ledger creates without a request. */
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
    const count = Math.ceil(file.size / chunkBytes);
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

/** Downloads every chunk the record says is missing into `dir`, verifies
 *  each file as it completes, and returns `dir`. Running it again after
 *  an interruption fetches only what is missing. */
export async function downloadHubSnapshot(
  snapshot: HubSnapshot,
  dir: string,
  options: DownloadOptions = {},
): Promise<string> {
  const emit = options.onEvent ?? (() => {});
  const chunkBytes = options.chunkBytes ?? CHUNK_BYTES;
  const hub = new HubClient(options);
  const r = root(dir);
  mkdir(r, ".");

  const ledger = await Ledger.open(r, dir, snapshot, emit);
  const plan = planChunks(snapshot, ledger.record, chunkBytes);
  ledger.expect(plan);
  for (const filePath of ledger.unverified()) {
    await verifyFile(r, ledger, filePath, emit);
  }
  announceFiles(plan, ledger.record, chunkBytes, emit);
  const progress = new Progress(snapshot, plan, emit);
  const files = new OpenFiles(r, ledger);
  const urls = new FileUrls(hub, snapshot);

  const fetchChunk = async (chunk: Chunk): Promise<void> => {
    const file = files.open(chunk.path);
    let received = 0;
    try {
      await hub.fetchRange(
        await urls.get(chunk.path),
        chunk,
        ledger.sizeOf(chunk.path),
        (piece) => {
          file.writeAt(piece, chunk.start + received);
          received += piece.length;
          progress.streamed(piece.length);
        },
      );
    } catch (err) {
      progress.discard(received);
      throw err;
    }
  };

  const downloadChunk = async (chunk: Chunk): Promise<void> => {
    await withRetries(chunk, options.retryDelayMs ?? 1000, urls, () => fetchChunk(chunk));
    ledger.chunkDone(chunk);
    progress.landed(chunk.end - chunk.start);
    if (ledger.remaining(chunk.path) === 0) {
      files.close(chunk.path);
      await verifyFile(r, ledger, chunk.path, emit);
    }
  };

  try {
    await runPool(options.concurrency ?? DEFAULT_CONCURRENCY, plan, downloadChunk);
  } finally {
    files.closeAll();
  }
  return dir;
}

/** Runs `work` over `items` from `size` workers, and stops handing out
 *  items once one has failed. Rejects with that first failure. */
async function runPool<T>(
  size: number,
  items: T[],
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failed: Error | null = null;
  const worker = async (): Promise<void> => {
    while (failed === null && next < items.length) {
      try {
        await work(items[next++]);
      } catch (err) {
        failed = failed ?? (err as Error);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, size) }, worker));
  if (failed !== null) {
    throw failed;
  }
}

/** Retries a chunk through transport failures, waiting longer each time.
 *  An expired CDN URL does not count as a failure. The file is resolved
 *  again, once. */
async function withRetries(
  chunk: Chunk,
  delayMs: number,
  urls: FileUrls,
  attempt: () => Promise<void>,
): Promise<void> {
  let failures = 0;
  let refreshed = false;
  for (;;) {
    try {
      await attempt();
      return;
    } catch (err) {
      if (err instanceof Expired && !refreshed) {
        refreshed = true;
        urls.forget(chunk.path);
        continue;
      }
      failures += 1;
      if (failures >= RETRIES) {
        throw err;
      }
      await sleep(delayMs * 2 ** (failures - 1));
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A record keyed by Hub file paths, which are outside our control, so a
 *  file named `constructor` or `__proto__` is an own key like any other. */
function dictionary<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/** One resolve per file, even when several workers start on it at once. */
class FileUrls {
  private urls: Record<string, Promise<string>> = dictionary();

  constructor(
    private readonly hub: HubClient,
    private readonly snapshot: HubSnapshot,
  ) {}

  get(filePath: string): Promise<string> {
    if (this.urls[filePath] === undefined) {
      // A failed resolve is forgotten, so the next attempt asks again.
      this.urls[filePath] = this.hub.resolveFileUrl(this.snapshot, filePath).catch((err) => {
        this.forget(filePath);
        throw err;
      });
    }
    return this.urls[filePath];
  }

  forget(filePath: string): void {
    delete this.urls[filePath];
  }
}

/** The record on disk, kept current as chunks land. Every write goes
 *  through here, so a Ctrl-C loses at most the chunk in flight. */
class Ledger {
  private left: Record<string, number> = dictionary();

  private constructor(
    private readonly dir: string,
    readonly record: MlxModelRecord,
  ) {}

  /** The record to download against: the one on disk when it is for this
   *  revision, else a fresh one. A file already on disk with no record
   *  and the right hash is adopted rather than fetched again. An empty
   *  file is created here, since it has no bytes to fetch. */
  static async open(r: Root, dir: string, snapshot: HubSnapshot, emit: Emit): Promise<Ledger> {
    const existing = readMlxModelRecord(dir);
    if (existing !== null && existing.revision !== snapshot.revision) {
      throw revisionMismatch(dir, snapshot, existing.revision);
    }
    const files: Record<string, MlxFileRecord> = dictionary();
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
      if (file.size === 0) {
        emit({ kind: "file-start", path: file.path, size: 0, resumedBytes: 0 });
        mkdir(r, path.dirname(file.path));
        writeBytes(r, file.path, Buffer.alloc(0));
        entry.complete = true;
        delete entry.chunks;
        emit({ kind: "file-done", path: file.path });
        emit({ kind: "verify", path: file.path, ok: true });
      } else if (existing === null && (await matchesOnDisk(r, file))) {
        entry.complete = true;
        delete entry.chunks;
        emit({ kind: "adopt", path: file.path });
      }
      files[file.path] = entry;
    }
    const ledger = new Ledger(dir, { repo: snapshot.repo, revision: snapshot.revision, files });
    ledger.save();
    return ledger;
  }

  /** Tells the ledger which chunks this run will fetch. */
  expect(plan: Chunk[]): void {
    for (const chunk of plan) {
      this.left[chunk.path] = (this.left[chunk.path] ?? 0) + 1;
    }
  }

  /** Files whose chunks all landed but were never verified: a run that
   *  died between the last chunk and the hash leaves one of these. */
  unverified(): string[] {
    return Object.keys(this.record.files).filter(
      (filePath) => !this.record.files[filePath].complete && this.left[filePath] === undefined,
    );
  }

  sizeOf(filePath: string): number {
    return this.record.files[filePath].size;
  }

  /** True when no chunk of the file is on disk yet, so the file can be
   *  started from nothing. */
  startsFresh(filePath: string): boolean {
    return (this.record.files[filePath].chunks ?? []).length === 0;
  }

  remaining(filePath: string): number {
    return this.left[filePath];
  }

  chunkDone(chunk: Chunk): void {
    const entry = this.record.files[chunk.path];
    entry.chunks = [...(entry.chunks ?? []), chunk.index];
    this.left[chunk.path] -= 1;
    this.save();
  }

  fileVerified(filePath: string): void {
    const entry = this.record.files[filePath];
    entry.complete = true;
    delete entry.chunks;
    this.save();
  }

  /** Forget the file's chunks, so the next run fetches it whole. */
  fileRejected(filePath: string): void {
    const entry = this.record.files[filePath];
    this.record.files[filePath] = { ...entry, complete: false, chunks: [] };
    this.save();
  }

  private save(): void {
    writeMlxModelRecord(this.dir, this.record);
  }
}

function revisionMismatch(dir: string, snapshot: HubSnapshot, held: string): Error {
  return new Error(
    `${dir} holds revision ${held.slice(0, 7)}, but ${snapshot.repo} is now at ` +
      `${snapshot.revision.slice(0, 7)}. Remove it or pin the old revision with ` +
      `mlx:${snapshot.repo}@${held.slice(0, 7)}.`,
  );
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

/** Hashes a finished LFS file, or checks the size of a plain one. A bad
 *  LFS file is moved aside by `verifyModelFile`; a bad plain file is
 *  truncated on the next run, since it starts from no chunks. Either way
 *  the run fails and the next one fetches that file whole. */
async function verifyFile(r: Root, ledger: Ledger, filePath: string, emit: Emit): Promise<void> {
  const entry = ledger.record.files[filePath];
  try {
    if (entry.sha256 !== undefined) {
      await verifyModelFile(resolveUnder(r, filePath), entry.sha256, filePath);
    } else {
      const size = stat(r, filePath)?.size ?? -1;
      if (size !== entry.size) {
        throw new Error(`${filePath} is ${size} bytes, expected ${entry.size}`);
      }
    }
  } catch (err) {
    ledger.fileRejected(filePath);
    emit({ kind: "verify", path: filePath, ok: false });
    throw err;
  }
  ledger.fileVerified(filePath);
  emit({ kind: "file-done", path: filePath });
  emit({ kind: "verify", path: filePath, ok: true });
}

/** One descriptor per file being written, opened on first use. A file
 *  with no chunks on disk is truncated first, so bytes left by an older
 *  or larger copy cannot outlive the download. */
class OpenFiles {
  private handles: Record<string, WritableFile> = dictionary();

  constructor(
    private readonly root: Root,
    private readonly ledger: Ledger,
  ) {}

  open(filePath: string): WritableFile {
    if (this.handles[filePath] === undefined) {
      mkdir(this.root, path.dirname(filePath));
      const file = openForWrite(this.root, filePath);
      if (this.ledger.startsFresh(filePath)) {
        file.truncate(0);
      }
      this.handles[filePath] = file;
    }
    return this.handles[filePath];
  }

  close(filePath: string): void {
    if (this.handles[filePath] !== undefined) {
      this.handles[filePath].close();
      delete this.handles[filePath];
    }
  }

  closeAll(): void {
    for (const filePath of Object.keys(this.handles)) {
      this.close(filePath);
    }
  }
}

/** Bytes on disk plus bytes in flight, reported at most twice a second,
 *  and once more, unconditionally, when the last byte lands. */
class Progress {
  private inFlight = 0;
  private done: number;
  private readonly total: number;
  private lastEvent = 0;

  constructor(
    snapshot: HubSnapshot,
    plan: Chunk[],
    private readonly emit: Emit,
  ) {
    this.total = snapshot.files.reduce((sum, f) => sum + f.size, 0);
    this.done = this.total - plan.reduce((sum, c) => sum + (c.end - c.start), 0);
  }

  streamed(n: number): void {
    this.inFlight += n;
    this.report(false);
  }

  /** A failed attempt's bytes are not on disk; count them out again. */
  discard(n: number): void {
    this.inFlight -= n;
  }

  landed(n: number): void {
    this.inFlight -= n;
    this.done += n;
    this.report(this.done === this.total);
  }

  private report(force: boolean): void {
    const now = Date.now();
    if (force || now - this.lastEvent >= 500) {
      this.lastEvent = now;
      this.emit({ kind: "bytes", done: this.done + this.inFlight, total: this.total });
    }
  }
}

/** Emits `file-start` once per file in the plan. */
function announceFiles(plan: Chunk[], record: MlxModelRecord, chunkBytes: number, emit: Emit) {
  const seen: string[] = [];
  for (const chunk of plan) {
    if (!seen.includes(chunk.path)) {
      seen.push(chunk.path);
      const entry = record.files[chunk.path];
      emit({
        kind: "file-start",
        path: chunk.path,
        size: entry.size,
        resumedBytes: (entry.chunks ?? []).reduce(
          (sum, i) => sum + Math.min(entry.size, (i + 1) * chunkBytes) - i * chunkBytes,
          0,
        ),
      });
    }
  }
}
