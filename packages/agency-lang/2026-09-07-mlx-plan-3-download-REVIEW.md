# Review of MLX Plan 3: Downloading MLX models

Reviewed 2026-09-07 against `main` at 97143b9de and against the live
Hugging Face API with `curl`. Every plan 1 name the plan consumes exists
with the shape it assumes: `MlxFileRecord.chunks`, `readMlxModelRecord`,
`writeMlxModelRecord`, `mlxModelDir`, `parseMlxUri`, `isModelDir`,
`verifyModelFile(filePath, expected, name)`, and `contained.ts` exports
`root`, `resolveUnder`, `mkdir`. The lint fence (`FS_IMPORTERS` in
`eslint.config.js:8`) works the way the plan says.

The design is right. Several facts about the Hub in the plan are wrong, and
two of the tests as described cannot pass. Details below, most serious first.

## Blocking

### 1. The gated-repo model in the fake does not match the Hub

The fake returns 401 from `GET /api/models/<repo>` when the repo is gated
and there is no token, and task 2 detects gating from that. The real Hub
does not do this. Checked today on `meta-llama/Llama-3.1-8B-Instruct`
without a token:

| Endpoint | Status |
|---|---|
| `/api/models/<repo>` | 200, body has `"gated": …` |
| `/api/models/<repo>/tree/main?recursive=true` | 200, full file list |
| `/<repo>/resolve/main/config.json` | 401 |

So a downloader built to the fake would read the snapshot fine, start
downloading, and fail on the first resolve with a bare 401. Fix the fake
and the code together: the model API returns `gated: true` in its 200 body;
`fetchHubSnapshot` throws the gated message when `gated` is truthy and no
token was given; the resolve route returns 401 without an `Authorization`
header; and the downloader maps a 401 or 403 on resolve to the same
message, since a token that has not accepted the terms gets that too.

### 2. A pinned revision reads the wrong commit

Task 2 says to read `/api/models/<repo>` for the sha, then the tree at that
sha. That endpoint reports `main`. For `mlx:org/repo@7b9321e` the revision
must come from `/api/models/<repo>/revision/<rev>`. Checked: that endpoint
accepts the short sha and returns the full one
(`7b9321eabb85ce79625cac3f61ea691e4ea984b5`). Use it whenever a revision was
given, and `/api/models/<repo>` otherwise. The fake needs the route.

### 3. The quarantine test cannot pass as described

Task 3's quarantine test overwrites a file with garbage and sets its record
to `complete: false, chunks: []`. With no chunks recorded, `planChunks`
schedules every chunk, the run overwrites the garbage with good bytes, the
hash matches, and no `.invalidSha` appears. The assertion fails on a correct
implementation.

To reach the quarantine path the record must claim chunks that are wrong on
disk. Corrupt the file and set `chunks` to every index but the last. The run
fetches one chunk, hashes, mismatches, quarantines, and rejects.

That exposes a gap in step 7. After `verifyModelFile` moves the file aside
and throws, the record still says most chunks are done. The next run plans
one chunk for a file that no longer exists. Step 7 must reset that file's
entry to `chunks: []` and write the record before rethrowing. The test's
third run, which expects the file back and correct, is what checks this.

### 4. The resume test assumes one request in flight

"Assert every range in `rangeHits` is 1 except the chunk that was in flight"
holds only with one worker. The default is 8, so up to 8 chunks are in
flight when the wrapper throws, and up to 8 ranges are hit twice. Run that
test with `concurrency: 1`, or assert that no range is hit more than twice
and that the total of double hits is at most the concurrency.

## Should fix before executing

### 5. Redirects: relative locations, and more than one hop

Task 3 step 6 fetches `resolve/` with `redirect: "manual"`, reads
`location`, and requires it to be `https:`. Two observations from today:

- A small non-LFS file (`config.json`) redirects with a relative
  `location: /api/resolve-cache/models/...`, same host, then that redirects
  again. A relative location fails the `https:` check and the plan has no
  second hop.
- A safetensors shard redirects once, 302, to an absolute
  `https://us.aws.cdn.hf.co/xet-bridge-us/...` URL that honours `Range` with
  206 and a correct `content-range` total.

Resolve each `location` against the URL it came from with `new URL(loc, from)`,
follow up to 5 hops, and apply the `https:` rule to each resolved hop. Send
`Authorization` only on hops whose host is the hub host. The fake should
include one relative hop so this is tested.

### 6. The signed CDN URL expires

The CDN URL carries `Expires=<epoch>` and a signature. A file that takes
longer than the signature window fails with 403 partway. The plan's
"re-resolve once on 403" covers it, as long as the retry re-resolves rather
than retrying the same URL. Say so in step 6, and have the fake's
`failNextResolve` test set the flag on a CDN request, not on `resolve/`,
because that is what an expired signature looks like.

### 7. Files in subdirectories

Repos have paths like `original/consolidated.00.pth`. Step 5 opens each file
by resolved path without creating its parent. Call `mkdir(r, path.dirname(file.path))`
before opening. The fake should include one nested path.

### 8. The record on disk while chunks land

Eight workers each call `writeMlxModelRecord` after every chunk. Each write
is a temp file plus rename, so it is safe, and at 64 MiB per chunk it is
rare. Fine. But the record object they mutate is shared, so mutate it and
write it on one path (a `recordChunk(path, index)` function), not from
inside each worker's closure, or two workers can write stale copies of each
other's progress.

### 9. Tree API paging

The tree API paginates with a `Link: <…>; rel="next"` header. Today's MLX
repos are small (DeepSeek V4 Flash lists 41 entries), so no page overflows.
Read the `Link` header and follow it anyway. If that is too much for this
PR, throw when a `Link` header is present, so a large repo fails loudly
instead of silently downloading half of itself.

### 10. Where the fake hub lives

`lib/stdlib/hubDownload.testHub.ts` is shipped in `dist` (tsconfig has no
exclude for it) and is lint-checked as production code. The repo has a
place for this already: `lib/stdlib/__tests__/` is in the eslint ignore
list and vitest only collects `*.test.ts`. Put it at
`lib/stdlib/__tests__/fakeHub.ts`. Task 1's "check tsconfig exclude first"
can then go.

### 11. Small things

- `planChunks` is declared with two parameters in the interface block and
  called with three in the test. The implementation has three. Fix the
  declaration.
- Step 5 opens with `"a+"` then reopens `"r+"`. One `fs.openSync(p, fs.constants.O_RDWR | fs.constants.O_CREAT)` does it.
- `configuredConcurrency()` reads `agency.json` the way `defaultCacheDir`
  does, through the private `readJson`. Plan 2's review asks for an
  exported `readClientConfig()`; use it here. If plan 3 lands before plan
  2, the `client.mlx` schema key must be added here.
- Task 4's test calls `_downloadModel("mlx:org/repo", dir, { hubUrl, allowHttp })`.
  Make the third parameter default to `{}` so existing callers compile.
- The spec's test list item 14 says "with a token, the header is sent". No
  test in the plan asserts the header reached the fake. Have the fake record
  the `Authorization` header on the model API and on `resolve/`, and assert
  both.

## Altitude

The question is whether the repo already owns any of this.

- Ranged, resumable HTTP download: nothing in `lib/`. The GGUF path
  delegates to `smoltalk-llama-cpp`, which is node-llama-cpp's downloader
  and cannot be pointed at a safetensors repo. New code is right.
- Offset writes: `contained.ts` has `writeBytes` with `append` mode
  (`contained.ts:300`), which opens through `openForAppend` and
  `validateDescriptor`. It cannot write at an offset. The allow-list entry
  is the honest route, and the plan keeps the fence tight: every path goes
  through `resolveUnder` first. One improvement: the plan could reuse
  `validateDescriptor` after its own `openSync`, if that function were
  exported, so the descriptor check that guards every other write also
  guards this one. Worth a look, not a blocker.
- Hashing and quarantine: reused from `verifyModelFile`. Good.
- Progress printing: `runDownload` in `lib/cli/local.ts:100` prints nothing
  during a GGUF download today, so there is no convention to follow. The
  `\r` line is fine.

No duplicated layer here.

## Things that would make a test fail

Items 1, 3, and 4 are tests that fail against a correct implementation or
pass against a wrong one. After the fixes, the tests that carry the
weight are: byte-identical output, resume without re-requests (with
concurrency 1), quarantine then recovery, relative-redirect following, and
the gated 401 on resolve.

## The Studio step

Task 5 step 2 measures 8 vs 16 workers. Add a third number: the same file
with the owner's existing `~/download-models.sh` (hf_xet, up to 64
streams), so the PR body says whether our downloader is within reach of the
tool the owner uses today. If it is far behind, the fix is more workers or
a bigger chunk, and the number tells you which.
