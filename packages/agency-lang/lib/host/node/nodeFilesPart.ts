// The file part of nodeHost: the contained operations in nodeFiles.ts,
// each wrapped in a promise. One operation still runs in one piece, with
// the same checks, and takes the same time. Node-only.

import fs from "fs";
import type { FileStat, HostFiles, WriteOptions } from "../host.js";
import * as files from "./nodeFiles.js";
import type { Seams } from "./nodeFiles.js";

export type NodeFilesOptions = {
  /** Test-only hook that runs between the open and the validation of a
   *  descriptor, where a concurrent swap would land. The symlink tests
   *  build their host with it. */
  seams?: Seams;
};

function fileStat(info: fs.Stats): FileStat {
  const kind = info.isFile() ? "file" : info.isDirectory() ? "dir" : "other";
  return { kind, size: info.size, modifiedMs: info.mtimeMs };
}

/** `cwd` is the host's working folder, which a relative path is resolved
 *  against. Left out, it is the process's folder at the time of each call. */
export function nodeFilesPart(options: NodeFilesOptions = {}, cwd?: string): HostFiles {
  const seams = options.seams ?? {};
  const withSeams = (writeOptions: WriteOptions | undefined): files.WriteOptions => ({
    ...writeOptions,
    seams,
  });
  // One lock per path. A caller that holds it waits for the one before.
  const locks: Record<string, Promise<void>> = {};

  const base = (): string => cwd ?? process.cwd();

  return {
    root: async (dir) => files.root(dir, base()),
    fixedRoot: async (dir) => files.fixedRoot(dir, base()),
    realDir: async (dir) => files._realDir(dir, base()),
    wholePath: async (p) => files.wholePath(p, base()),
    fixedPath: async (p) => files.fixedPath(p, base()),
    realPath: async (p) => files._realTarget(p, base()),
    resolvePath: async (root, target) => files.resolveUnder(root, target),
    locate: async (dir, filename, operation, dirMayBeMissing) =>
      files.locateSync(dir, filename, operation, dirMayBeMissing, base()),
    withLock: async (root, target, work) => {
      const key = files.resolveUnder(root, target);
      const previous = locks[key] ?? Promise.resolve();
      let release!: () => void;
      const held = new Promise<void>((done) => {
        release = done;
      });
      // The chain the next caller waits on. Kept so the last one out can
      // tell it is last and drop the entry, or the object grows by one
      // path forever on a long-lived host.
      const queued = previous.then(() => held);
      locks[key] = queued;
      await previous;
      try {
        return await work();
      } finally {
        release();
        if (locks[key] === queued) {
          delete locks[key];
        }
      }
    },
    readText: async (root, target) => files.readText(root, target, seams),
    readBytes: async (root, target) => new Uint8Array(files.readBytes(root, target, seams)),
    readChunks: (root, target) => readChunks(root, target, seams),
    list: async (root, target) => files.list(root, target),
    stat: async (root, target) => {
      const info = files.stat(root, target);
      return info === null ? null : fileStat(info);
    },
    writeText: async (root, target, content, writeOptions) =>
      files.writeText(root, target, content, withSeams(writeOptions)),
    writeBytes: async (root, target, bytes, writeOptions) =>
      files.writeBytes(root, target, Buffer.from(bytes), withSeams(writeOptions)),
    // Synchronous reads and writes with nothing between them, which is how
    // this host meets the rule that no other call on the file runs in the
    // middle of an update. The read refuses a link at the final name the
    // way every read does; only a missing file reads as null.
    updateText: async (root, target, change) => {
      let current: string | null;
      try {
        current = files.readText(root, target, seams);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
        current = null;
      }
      files.writeText(root, target, change(current), { seams });
    },
    openForWrite: async (root, target, openOptions) => {
      const open = files.openForWrite(root, target, { ...openOptions, seams });
      return {
        writeAt: async (data, position) => open.writeAt(data, position),
        truncate: async (size) => open.truncate(size),
        close: async () => open.close(),
      };
    },
    openForAppend: async (root, target, openOptions) => {
      const open = files.openForAppend(root, target, { ...openOptions, seams });
      return {
        append: async (data) => open.append(data),
        close: async () => open.close(),
      };
    },
    mkdir: async (root, target) => files.mkdir(root, target),
    privateDir: async (root, target, options) => files.privateDir(root, target, options),
    remove: async (root, target) => files.remove(root, target),
    copy: async (from, to) => files.copy(from, to),
    move: async (from, to) => files.move(from, to),
  };
}

async function* readChunks(
  root: files.Root,
  target: string,
  seams: Seams,
): AsyncIterable<Uint8Array> {
  const stream = files.readStream(root, target, seams);
  for await (const chunk of stream) {
    yield typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
  }
}
