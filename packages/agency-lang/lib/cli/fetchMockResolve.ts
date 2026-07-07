import * as fs from "fs";
import * as path from "path";
import type { FetchMock } from "../runtime/fetchMock.js";

// Merge file-level + per-test fetch mocks (per-test FIRST so it wins under the
// shim's first-match-wins rule) and inline any `returnFile` relative to
// `baseDir`. The result is safe to hand to installFetchMock: `return` is always
// present and `returnFile` is stripped. Throws on a missing file or on an entry
// that sets both `return` and `returnFile`.
export function resolveFetchMocks(
  fileLevel: FetchMock[] | undefined,
  perTest: FetchMock[] | undefined,
  baseDir: string,
): FetchMock[] {
  const merged = [...(perTest ?? []), ...(fileLevel ?? [])];
  return merged.map((m, i) => inlineReturnFile(m, i, baseDir));
}

function inlineReturnFile(m: FetchMock, i: number, baseDir: string): FetchMock {
  if (m.returnFile === undefined) {
    return m;
  }
  if (m.return !== undefined) {
    throw new Error(`fetchMock[${i}]: set only one of "return" or "returnFile".`);
  }
  const filePath = path.resolve(baseDir, m.returnFile);
  if (!fs.existsSync(filePath)) {
    throw new Error(`fetchMock[${i}]: returnFile not found: ${filePath}`);
  }
  const contents = fs.readFileSync(filePath, "utf-8");
  const { returnFile, ...rest } = m;
  return { ...rest, return: contents };
}
