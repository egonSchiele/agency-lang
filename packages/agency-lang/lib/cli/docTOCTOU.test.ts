import { describe, expect, test, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// End-to-end regression for the mid-render dependency race: a dependency
// saved between the pre-render snapshot and rendering must leave the
// caller's entry uncacheable, and the next run must reach cold parity.
// Isolated in its own file because the injection wraps captureDepSnapshot
// module-wide.
const inject = vi.hoisted(() => ({
  /** Run once, right after the snapshot for this source basename. */
  afterSnapshotOf: "",
  mutate: null as (() => void) | null,
}));
vi.mock("./docLedger.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./docLedger.js")>();
  return {
    ...real,
    captureDepSnapshot: (absSource: string, config: unknown, stdlibDir: string) => {
      const snapshot = real.captureDepSnapshot(absSource, config as never, stdlibDir);
      if (inject.mutate && path.basename(absSource) === inject.afterSnapshotOf) {
        const m = inject.mutate;
        inject.mutate = null; // fire once
        m();
      }
      return snapshot;
    },
  };
});

import { generateDoc } from "./doc.js";
import { loadDocLedger } from "./docLedger.js";
import { evictParseCache } from "../parseCache.js";

const dirs: string[] = [];
function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return fs.realpathSync(d);
}
afterEach(() => {
  inject.mutate = null;
  inject.afterSnapshotOf = "";
  for (const d of dirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

describe("mid-render dependency drift", () => {
  test("dep saved after the snapshot: caller uncacheable; next run reaches cold parity", () => {
    const inputDir = tmp("agency-toctou-in-");
    const bPath = path.join(inputDir, "b.agency");
    fs.writeFileSync(
      bPath,
      `effect race::old { value: string }\neffect race::new { value: string }\n\nexport def b(): string {\n  raise race::old("go", { value: "v" })\n  return "b"\n}\n`,
    );
    fs.writeFileSync(
      path.join(inputDir, "a.agency"),
      `import { b } from "./b.agency"\nexport def a(): string { return b() }\n`,
    );
    const out = tmp("agency-toctou-out-");

    // The injection fires right after a.agency's pre-render snapshot —
    // i.e. mid-render from the cache's point of view: the snapshot holds
    // the OLD dep bytes, rendering and the post-render fingerprint see
    // the NEW ones.
    inject.afterSnapshotOf = "a.agency";
    inject.mutate = () => {
      fs.writeFileSync(
        bPath,
        `effect race::old { value: string }\neffect race::new { value: string }\n\nexport def b(): string {\n  raise race::new("go", { value: "v" })\n  return "b"\n}\n`,
      );
      evictParseCache(bPath);
    };
    generateDoc({}, inputDir, out, []);

    const { ledger, authority } = loadDocLedger(out);
    expect(authority).toBe(true);
    expect(ledger!.entries["a.agency"].cacheable).toBe(false); // never served fresh

    // Next run repairs: byte parity with a cold run over the final state.
    generateDoc({}, inputDir, out, []);
    const cold = tmp("agency-toctou-cold-");
    generateDoc({}, inputDir, cold, []);
    const read = (d: string, f: string) => fs.readFileSync(path.join(d, f), "utf-8");
    expect(read(out, "a.md")).toBe(read(cold, "a.md"));
    expect(read(out, "a.md")).toContain("race::new");
    expect(loadDocLedger(out).ledger!.entries["a.agency"].cacheable).toBe(true);
  });
});
