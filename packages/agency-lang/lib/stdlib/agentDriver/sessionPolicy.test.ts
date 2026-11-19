import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { minimalAutoApprovePolicy } from "../../runtime/builtinPolicies.js";
import type { Policy } from "../../runtime/policy.js";
import { failure, success } from "../../types/result.js";
import { safeDeleteDirectoryWithin } from "../../utils.js";
import { sessionRunPolicy } from "./policy.js";
import { POLICY_UNREADABLE, readCarriedPolicy, saveCarriedPolicy } from "./sessionPolicy.js";

async function withHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = fs.mkdtempSync(path.join(process.cwd(), ".session-policy-test-"));
  try {
    await fn(home);
  } finally {
    expect(safeDeleteDirectoryWithin(process.cwd(), home).success).toBe(true);
  }
}

function writePolicyFile(home: string, id: string, text: string): void {
  fs.mkdirSync(path.join(home, "session-policies"), { recursive: true });
  fs.writeFileSync(path.join(home, "session-policies", `${id}.json`), text);
}

describe("the session's policy file", () => {
  it("reads back the policy saved for the session", async () => {
    await withHome(async (home) => {
      const saved = await saveCarriedPolicy({ home, id: "s1", policy: minimalAutoApprovePolicy });
      expect(saved).toEqual(success(null));
      expect(fs.existsSync(path.join(home, "session-policies", "s1.json"))).toBe(true);
      expect(await readCarriedPolicy({ home, id: "s1" })).toEqual(
        success(minimalAutoApprovePolicy),
      );
    });
  });

  it("is null for a session that has none", async () => {
    await withHome(async (home) => {
      expect(await readCarriedPolicy({ home, id: "s1" })).toEqual(success(null));
    });
  });

  it("refuses to save a policy that is not valid, and writes nothing", async () => {
    await withHome(async (home) => {
      const odd = { "std::read": [{ action: "maybe" }] } as unknown as Policy;
      const saved = await saveCarriedPolicy({ home, id: "s1", policy: odd });
      expect(saved.success).toBe(false);
      expect(fs.existsSync(path.join(home, "session-policies"))).toBe(false);
    });
  });

  it("refuses an id that is not a plain file name", async () => {
    await withHome(async (home) => {
      for (const id of ["../policy", "a/b", ".hidden", ""]) {
        const saved = await saveCarriedPolicy({ home, id, policy: {} });
        expect(saved.success, id).toBe(false);
      }
    });
  });

  // A null would run the session under the user's saved policy.
  it("is POLICY_UNREADABLE, never null, for a file that is not valid JSON or not a policy", async () => {
    await withHome(async (home) => {
      writePolicyFile(home, "broken", "{ not json");
      writePolicyFile(home, "odd", JSON.stringify({ "std::read": [{ action: "maybe" }] }));
      for (const id of ["broken", "odd"]) {
        expect(await readCarriedPolicy({ home, id })).toEqual(failure(POLICY_UNREADABLE));
      }
    });
  });

  it("makes sessionRunPolicy fail when it can't be read", async () => {
    await withHome(async (home) => {
      writePolicyFile(home, "broken", "{ not json");
      const carried = await readCarriedPolicy({ home, id: "broken" });
      const saved: Policy = { "std::read": [{ action: "approve" }] };
      expect(sessionRunPolicy({ carried, saved, extra: null })).toEqual(failure(POLICY_UNREADABLE));
    });
  });
});
