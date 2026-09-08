# MLX Plan 3: Downloading MLX models

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `agency local download mlx:<org>/<repo>` fetches a whole model repo from Hugging Face, in parallel, resumably, and verified, with no new dependency.

**Architecture:** A new file, `lib/stdlib/hubDownload.ts`, reads the repo's file list from the Hugging Face API, splits each file into 64MB chunks, fetches chunks with byte-range requests on a pool of workers, writes each chunk at its offset, and records progress in `.agency-model.json`. A second run skips what is done. Finished files are hashed against the API's SHA-256.

**Tech Stack:** TypeScript, `fetch`, `node:fs` for offset writes, vitest with a fake Hub over `node:http`.

**Spec:** `2026-09-07-mlx-local-models-spec.md`, sections 2 (The download), 3.3, 3.4. Depends on Plan 1.

## Global Constraints

- No new npm dependency.
- Chunk size 64 MiB. Workers: `client.mlx.downloadConcurrency`, default 8.
- Every redirect target must be `https:`.
- A chunk is retried 3 times with backoff before the download fails.
- Hash mismatch quarantines to `<file>.invalidSha`, the same as GGUF.
- `HF_TOKEN`, when set, is sent as `Authorization: Bearer` and never stored.
- `hubDownload.ts` is the only new file allowed to import `fs`. It goes in `FS_IMPORTERS` in `eslint.config.js`.
- Same repo rules as Plan 1.

---

### Task 0: Branch

```bash
cd /Users/adityabhargava/agency-lang
git worktree add worktree-mlx-download -b adit/mlx-download main
cd worktree-mlx-download/packages/agency-lang
git checkout adit/mlx-spike -- packages/agency-lang/2026-09-07-mlx-plan-3-download.md
make > /tmp/make.log 2>&1; tail -3 /tmp/make.log
```

---

### Task 1: The fake Hub for tests

**Files:**
- Create: `lib/stdlib/hubDownload.fakeHub.ts` (test helper, not shipped: name it `hubDownload.testHub.ts` if the build globs `*.ts` under lib; check `tsconfig.json` `exclude` first)

**Interfaces:**
- Produces:
  ```ts
  export type FakeFile = { path: string; bytes: Buffer };
  export type FakeHub = {
    baseUrl: string;                 // "http://127.0.0.1:<port>"
    sha: string;                     // the commit the fake reports
    rangeHits: Record<string, number>;   // "<path> <start>-<end>" -> count
    gated: boolean;
    failNextResolve: boolean;        // next resolve/ returns 403, once
    close: () => Promise<void>;
  };
  export function startFakeHub(repo: string, files: FakeFile[], opts?: { gated?: boolean }): Promise<FakeHub>;
  ```

- [ ] **Step 1: Implement**

The fake answers four routes:

- `GET /api/models/<repo>`: `{ sha, gated }`. When `gated` and no `Authorization` header, 401.
- `GET /api/models/<repo>/tree/<rev>?recursive=true`: one entry per file with `type`, `path`, `size`, and for files over 1000 bytes an `lfs: { oid: sha256hex, size }`.
- `GET /<repo>/resolve/<rev>/<path>`: 302 to `/cdn/<path>?sig=1`. If `failNextResolve`, respond 403 once and clear the flag.
- `GET /cdn/<path>`: honours `Range: bytes=a-b` with 206 and `content-range`; without a range, 200 and the whole file. Counts each range in `rangeHits`.

Use `node:http` and `createHash("sha256")`. The `https:` rule in the downloader must be relaxable for tests: the downloader takes an `allowHttp` option that the fake-hub tests set and nothing else does.

- [ ] **Step 2: Commit**

```bash
git add lib/stdlib/hubDownload.testHub.ts
printf 'tests: a fake Hugging Face hub for download tests\n' > /tmp/msg.txt
git commit -F /tmp/msg.txt
```

---

### Task 2: Reading the snapshot

**Files:**
- Create: `lib/stdlib/hubDownload.ts`
- Test: `lib/stdlib/hubDownload.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type HubFile = { path: string; size: number; sha256?: string };
  export type HubSnapshot = { repo: string; revision: string; files: HubFile[] };
  export type HubOptions = { hubUrl?: string; token?: string; fetch?: typeof fetch; allowHttp?: boolean };
  export function fetchHubSnapshot(repo: string, revision: string | undefined, options?: HubOptions): Promise<HubSnapshot>;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
describe("fetchHubSnapshot", () => {
  it("returns the commit and every file with size and sha256", async () => {
    const hub = await startFakeHub("org/repo", [
      { path: "config.json", bytes: Buffer.from("{}") },
      { path: "model.safetensors", bytes: big },   // > 1000 bytes
    ]);
    const snap = await fetchHubSnapshot("org/repo", undefined, { hubUrl: hub.baseUrl, allowHttp: true });
    expect(snap.revision).toBe(hub.sha);
    expect(snap.files).toEqual([
      { path: "config.json", size: 2 },
      { path: "model.safetensors", size: big.length, sha256: sha256hex(big) },
    ]);
    await hub.close();
  });

  it("a gated repo without a token gives the token message; with a token it works", async () => {
    const hub = await startFakeHub("org/repo", [], { gated: true });
    await expect(fetchHubSnapshot("org/repo", undefined, { hubUrl: hub.baseUrl, allowHttp: true })).rejects.toThrow(
      "This repo is gated. Set HF_TOKEN to a Hugging Face token that has accepted its terms.",
    );
    await expect(fetchHubSnapshot("org/repo", undefined, { hubUrl: hub.baseUrl, allowHttp: true, token: "t" })).resolves.toBeTruthy();
    await hub.close();
  });
});
```

- [ ] **Step 2: Implement**

`hubUrl` defaults to `https://huggingface.co`. `revision` defaults to `main`. Read `/api/models/<repo>` first; on 401 or 403 with `gated: true` in a second unauthenticated probe, throw the gated message. Then `/api/models/<repo>/tree/<sha>?recursive=true` (use the sha, not `main`, so the file list and the revision agree). Keep entries with `type === "file"`. Send the token header when given. Reject any `hubUrl` that is not `https:` unless `allowHttp`.

- [ ] **Step 3: Run, then commit**

```bash
pnpm exec vitest run lib/stdlib/hubDownload.test.ts > /tmp/d2.log 2>&1; tail -6 /tmp/d2.log
pnpm run fmt:ts && pnpm run lint:structure
git add lib/stdlib/hubDownload.ts lib/stdlib/hubDownload.test.ts
printf 'hub download: read a repo snapshot from the Hugging Face API\n' > /tmp/msg.txt
git commit -F /tmp/msg.txt
```

`lint:structure` will fail here if `hubDownload.ts` imports `fs`. It does not yet. Task 3 adds the import and the allow-list entry together.

---

### Task 3: Chunk planning, offset writes, and the download loop

**Files:**
- Modify: `lib/stdlib/hubDownload.ts`
- Modify: `eslint.config.js` (`FS_IMPORTERS`)
- Test: `lib/stdlib/hubDownload.test.ts`

**Interfaces:**
- Consumes: `MlxModelRecord`, `readMlxModelRecord`, `writeMlxModelRecord`, `RECORD_FILE` from `mlxModelRecord.ts` (Plan 1).
- Produces:
  ```ts
  export const CHUNK_BYTES = 64 * 1024 * 1024;
  export type Chunk = { path: string; index: number; start: number; end: number };  // end exclusive
  export function planChunks(snapshot: HubSnapshot, record: MlxModelRecord | null): Chunk[];
  export type DownloadEvent =
    | { kind: "file-start"; path: string; size: number; resumedBytes: number }
    | { kind: "bytes"; done: number; total: number }
    | { kind: "file-done"; path: string }
    | { kind: "verify"; path: string; ok: boolean };
  export type DownloadOptions = HubOptions & { concurrency?: number; chunkBytes?: number; onEvent?: (e: DownloadEvent) => void };
  export function downloadHubSnapshot(snapshot: HubSnapshot, dir: string, options?: DownloadOptions): Promise<string>;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
describe("planChunks", () => {
  it("skips complete files and done chunks", () => {
    const snap = { repo: "r", revision: "s", files: [
      { path: "a", size: 10 }, { path: "b", size: 150 },
    ]};
    const record = { repo: "r", revision: "s", files: {
      a: { size: 10, complete: true },
      b: { size: 150, complete: false, chunks: [1] },
    }};
    expect(planChunks(snap, record, 64)).toEqual([
      { path: "b", index: 0, start: 0, end: 64 },
      { path: "b", index: 2, start: 128, end: 150 },
    ]);
  });
});

describe("downloadHubSnapshot", () => {
  it("produces byte-identical files and a complete record", async () => { /* start fake hub with 3 files, download into a temp dir with chunkBytes: 1000, compare bytes, read record, expect complete */ });

  it("resumes without re-requesting done chunks", async () => {
    // First run with a fetch wrapper that throws after the 3rd chunk request.
    // Second run completes. Assert every "<path> a-b" in hub.rangeHits is 1
    // except the chunk that was in flight when the throw happened.
  });

  it("quarantines a file whose bytes do not match and re-downloads only it next time", async () => {
    // After a clean download, overwrite one file with garbage and set its record
    // entry to complete: false, chunks: []. Run again: expect <file>.invalidSha
    // to exist ... then run again and expect the file to be back and correct,
    // and hub.rangeHits for the other files unchanged.
  });

  it("re-resolves once when the CDN URL returns 403", async () => {
    // hub.failNextResolve = true before the second chunk of a file; expect success
    // and two resolve hits for that file.
  });

  it("refuses when the record is from another revision", async () => {
    // write a record with revision "old"; expect the message from spec 3.4.
  });
});
```

Fill in the bodies using `startFakeHub`, a temp directory, and `chunkBytes: 1000` so a 5KB file has several chunks.

- [ ] **Step 2: Run and watch them fail**

```bash
pnpm exec vitest run lib/stdlib/hubDownload.test.ts > /tmp/d3.log 2>&1; grep -E "×|FAIL" /tmp/d3.log | head
```

- [ ] **Step 3: Implement**

Add `"lib/stdlib/hubDownload.ts": "assembles downloaded chunks at byte offsets into one file; contained.ts has no offset write; the directory is the configured models dir, the program's own spelling, and no interrupt names it",` to `FS_IMPORTERS` in `eslint.config.js`.

In `hubDownload.ts`:

```ts
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { root, resolveUnder, mkdir } from "./contained.js";
import { readMlxModelRecord, writeMlxModelRecord, type MlxModelRecord, type MlxFileRecord } from "./mlxModelRecord.js";
import { fileSha256, verifyModelFile } from "./localModels.js";

export const CHUNK_BYTES = 64 * 1024 * 1024;

export function planChunks(snapshot: HubSnapshot, record: MlxModelRecord | null, chunkBytes = CHUNK_BYTES): Chunk[] {
  const out: Chunk[] = [];
  for (const file of snapshot.files) {
    const rec = record?.files[file.path];
    if (rec?.complete === true && rec.size === file.size) continue;
    const done = rec?.size === file.size ? (rec.chunks ?? []) : [];
    const count = Math.max(1, Math.ceil(file.size / chunkBytes));
    for (let i = 0; i < count; i++) {
      if (done.includes(i)) continue;
      out.push({ path: file.path, index: i, start: i * chunkBytes, end: Math.min(file.size, (i + 1) * chunkBytes) });
    }
  }
  return out;
}
```

`downloadHubSnapshot(snapshot, dir, options)`:

1. `const r = root(dir); mkdir(r, ".")`. Every file path from the snapshot goes through `resolveUnder(r, file.path)` before it is opened, so a path like `../x` from a hostile tree listing is refused.
2. Read the record. If it exists and `record.revision !== snapshot.revision`, throw the other-revision message. If it does not exist but files are present on disk, hash each present file whose size matches and mark the matches complete before planning. Log that this is happening, since it is slow.
3. Build the record from the snapshot: one entry per file with `size`, `sha256`, `complete: false`, `chunks: []`, keeping any existing entry that is complete or partial with the same size.
4. `planChunks`. Emit `file-start` for every file with chunks in the plan, with `resumedBytes` = done chunks times chunk size.
5. Open each planned file once with `fs.openSync(resolved, "a+")` then reopen `"r+"`, so the file exists and can be written at any offset. Keep the descriptors in a map.
6. Run `concurrency` workers over the plan. A worker: get the CDN URL for the file (cached per file; resolve by fetching `<hubUrl>/<repo>/resolve/<revision>/<path>` with `redirect: "manual"` and reading `location`, which must be `https:` unless `allowHttp`); fetch it with `Range: bytes=<start>-<end-1>`; require 206 and a `content-range` whose total equals `file.size`; read the body into a Buffer; `fs.writeSync(fd, buf, 0, buf.length, start)`; add `index` to the record's `chunks` and write the record. A 403 on a cached CDN URL clears the cache entry and retries once. Any other failure retries 3 times with 1s, 2s, 4s waits, then rejects the whole download.
7. When a file's chunk list is full: close the descriptor; if `sha256` is known, `verifyModelFile(resolved, sha256, file.path)`, which quarantines and throws on mismatch; else check `fs.statSync(resolved).size === file.size`. Mark complete, clear `chunks`, write the record, emit `file-done` and `verify`.
8. Emit `bytes` events with running totals, at most twice a second.
9. Return `dir`.

The token goes into the `Authorization` header of the resolve request only. The CDN URL is signed and takes no header.

- [ ] **Step 4: Run, then commit**

```bash
pnpm exec vitest run lib/stdlib/hubDownload.test.ts > /tmp/d3.log 2>&1; tail -8 /tmp/d3.log
pnpm run fmt:ts && pnpm run lint:structure
git add lib/stdlib/hubDownload.ts lib/stdlib/hubDownload.test.ts eslint.config.js
printf 'hub download: parallel range chunks, resume, and verification\n' > /tmp/msg.txt
git commit -F /tmp/msg.txt
```

---

### Task 4: Wire `download` to it

**Files:**
- Modify: `lib/stdlib/localModels.ts` (`_downloadModel`)
- Modify: `lib/cli/local.ts` (`runDownload`, progress printing)
- Modify: `stdlib/agency/local.agency` (`downloadModel` docstring)
- Test: `lib/stdlib/localModels.test.ts`

- [ ] **Step 1: Write the failing test**

Replace the Plan 1 test that expects "not supported yet" with:

```ts
it("_downloadModel for an mlx: URI downloads into <cacheDir>/mlx/<org>--<repo>", async () => {
  const hub = await startFakeHub("org/repo", [{ path: "config.json", bytes: Buffer.from("{}") }, { path: "model.safetensors", bytes: big }]);
  const out = await _downloadModel("mlx:org/repo", dir, { hubUrl: hub.baseUrl, allowHttp: true });
  expect(out).toBe(path.join(dir, "mlx", "org--repo"));
  expect(fs.readFileSync(path.join(out, "config.json"), "utf-8")).toBe("{}");
  expect(isMlxModelComplete(readMlxModelRecord(out)!)).toBe(true);
  await hub.close();
});
```

`_downloadModel` gains a third, optional `hubOptions` argument used only by tests.

- [ ] **Step 2: Implement**

In `_downloadModel`, replace the Plan 1 throw:

```ts
  if (resolved.backend === "mlx") {
    if (isModelDir(resolved.target)) {
      return resolved.target;   // already on disk, nothing to fetch
    }
    const { repo, revision } = parseMlxUri(resolved.target);
    const dir = mlxModelDir(resolveCacheDir(cacheDir), repo);
    const snapshot = await fetchHubSnapshot(repo, revision, hubOptions);
    return await downloadHubSnapshot(snapshot, dir, {
      ...hubOptions,
      token: hubOptions.token ?? process.env.HF_TOKEN,
      concurrency: hubOptions.concurrency ?? configuredConcurrency(),
      onEvent: hubOptions.onEvent,
    });
  }
```

`configuredConcurrency()` reads `client.mlx.downloadConcurrency` from the nearest `agency.json` the way `defaultCacheDir` reads `modelsDir`, default 8.

In `runDownload`, pass an `onEvent` that prints: `file-start` as `<path>  <size GB>` plus `(resuming from <n> GB)` when `resumedBytes > 0`; `bytes` as a single rewritten line `  <done GB> / <total GB>` using `\r` when stdout is a TTY and nothing otherwise; `verify` as `  verified <path>` or the quarantine message. Print `model:  <dir>` at the end, as the GGUF path does.

Update the `downloadModel` docstring: "Returns the local .gguf path, or the model directory for an MLX model. MLX downloads resume if interrupted."

- [ ] **Step 3: Run, build, and commit**

```bash
pnpm exec vitest run lib/stdlib/localModels.test.ts lib/cli/local.test.ts > /tmp/d4.log 2>&1; tail -8 /tmp/d4.log
make > /tmp/make.log 2>&1; tail -3 /tmp/make.log
pnpm run fmt:ts && pnpm run lint:structure
git add lib/stdlib/localModels.ts lib/cli/local.ts stdlib/agency/local.agency lib/stdlib/localModels.test.ts
printf 'agency local download: fetch MLX models from Hugging Face\n' > /tmp/msg.txt
git commit -F /tmp/msg.txt
```

---

### Task 5: Dev doc, a real download, PR

- [ ] **Step 1: Dev doc**

Add "Downloading" to `docs/dev/llm/mlx-local-models.md`: the two Hub endpoints and what each gives, the chunk plan, why offset writes need `fs` and the allow-list entry, the resume and revision rules, verification and quarantine, the `HF_TOKEN` rule, and the concurrency setting. Remove the last "not here yet" line.

- [ ] **Step 2: A real download on the Studio**

Pick the smallest model on the drive that is not yet in the Agency models directory, or a small public MLX repo such as `mlx-community/Qwen3.5-0.8B-4bit` if one exists. Then:

```bash
export AGENCY_MODELS_DIR=/Volumes/adit-agency-models-sept-2026/agency-models
time pnpm run agency local download mlx:<repo>
```

Interrupt it with ctrl-c partway through and run it again. Expected: the second run prints `resuming from` lines and finishes. Then:

```bash
pnpm run agency local list
pnpm run agency local serve mlx:<repo> --python ~/mlx-env/bin/python
```

Try 8 and 16 workers on one run each by setting `client.mlx.downloadConcurrency`, and note the speeds in the PR body. If 16 is clearly faster, change the default.

- [ ] **Step 3: PR**

```bash
pnpm run typecheck > /tmp/tc.log 2>&1; tail -3 /tmp/tc.log
pnpm run fmt:ts && pnpm run lint:structure
git push -u origin adit/mlx-download
```

PR body in a file, with the measured speeds. Open with `gh pr create --body-file`. Do not merge.
