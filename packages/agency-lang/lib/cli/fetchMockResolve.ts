import * as fs from "fs";
import * as path from "path";
import { nanoid } from "nanoid";
import type { FetchMock } from "../runtime/fetchMock.js";
import { safeDeleteDirectory } from "../utils.js";

// Merge file-level + per-test fetch mocks (per-test FIRST so it wins under the
// shim's first-match-wins rule) and inline any `returnFile` relative to
// `baseDir`. The result is safe to hand to installFetchMock: every entry has a
// `return` and no `returnFile`. Throws (pointing at the test file) on a missing
// file, on an entry that sets both `return` and `returnFile`, or on one that
// sets neither.
export function resolveFetchMocks(
  fileLevel: FetchMock[] | undefined,
  perTest: FetchMock[] | undefined,
  baseDir: string,
): FetchMock[] {
  const merged = [...(perTest ?? []), ...(fileLevel ?? [])];
  return merged.map((mock, index) => inlineReturnFile(mock, index, baseDir));
}

function inlineReturnFile(mock: FetchMock, index: number, baseDir: string): FetchMock {
  if (mock.returnFile === undefined) {
    if (mock.return === undefined) {
      throw new Error(`fetchMock[${index}]: needs a "return" or a "returnFile".`);
    }
    return mock;
  }
  if (mock.return !== undefined) {
    throw new Error(`fetchMock[${index}]: set only one of "return" or "returnFile".`);
  }
  const filePath = path.resolve(baseDir, mock.returnFile);
  if (!fs.existsSync(filePath)) {
    throw new Error(`fetchMock[${index}]: returnFile not found: ${filePath}`);
  }
  const contents = fs.readFileSync(filePath, "utf-8");
  const { returnFile, ...rest } = mock;
  return { ...rest, return: contents };
}

// Write resolved fetch mocks to a temp file and hand back its path plus a
// cleanup callback for the caller's `finally`. The subprocess receives the
// path (via AGENCY_FETCH_MOCKS_FILE), not the JSON itself, so a large
// `returnFile` body can't exceed the exec argv/env size limit (ARG_MAX). The
// file lives under the project's gitignored `.agency-tmp/` — the same location
// typecheck uses — so `safeDeleteDirectory` (which refuses paths outside the
// project root) accepts it on cleanup.
export function writeFetchMocksTempFile(mocks: FetchMock[]): {
  file: string;
  cleanup: () => void;
} {
  const dir = path.join(process.cwd(), ".agency-tmp", `fetchmocks-${nanoid()}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "mocks.json");
  fs.writeFileSync(file, JSON.stringify(mocks));
  return {
    file,
    cleanup: () => {
      safeDeleteDirectory(dir, false);
    },
  };
}
