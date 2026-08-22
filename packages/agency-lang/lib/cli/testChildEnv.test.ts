import { describe, test, expect } from "vitest";
import { childEnvironment, testChildEnv } from "./testChildEnv.js";
import {
  AGENCY_MAX_COST,
  AGENCY_MAX_TIME,
  AGENCY_RUN_POLICY,
  AGENCY_RUN_POLICY_INTERACTIVE,
} from "@/constants.js";
import { resolveRunPolicy } from "./runPolicy.js";

const ALL_KEYS = [
  AGENCY_RUN_POLICY,
  AGENCY_RUN_POLICY_INTERACTIVE,
  AGENCY_MAX_COST,
  AGENCY_MAX_TIME,
];

describe("testChildEnv", () => {
  test("no flags: every carrier key is unset and nothing is set (no inheritance)", () => {
    const env = testChildEnv({});
    expect(env.set).toEqual({});
    expect([...env.unset].sort()).toEqual([...ALL_KEYS].sort());
  });

  test("--reject '*' carries a policy whose wildcard rule rejects", () => {
    const policy = resolveRunPolicy({ reject: "*", cwd: process.cwd() });
    expect(policy).not.toBeNull();
    const env = testChildEnv({ policy: policy ?? undefined });
    const parsed = JSON.parse(env.set[AGENCY_RUN_POLICY]) as Record<string, { action: string }[]>;
    expect(parsed["*"][0].action).toBe("reject");
  });

  test("a resolved budget maps to the two env names unchanged", () => {
    const env = testChildEnv({ budget: { maxCost: "5", maxTime: "60000" } });
    expect(env.set[AGENCY_MAX_COST]).toBe("5");
    expect(env.set[AGENCY_MAX_TIME]).toBe("60000");
  });
});

describe("childEnvironment", () => {
  test("removes the unset keys from the base before applying set", () => {
    const base = { [AGENCY_RUN_POLICY]: "inherited", KEEP: "yes", [AGENCY_MAX_COST]: "99" };
    const env = childEnvironment(base, [AGENCY_RUN_POLICY, AGENCY_MAX_COST], {
      [AGENCY_MAX_COST]: "1",
    });
    expect(env[AGENCY_RUN_POLICY]).toBeUndefined();
    expect(env[AGENCY_MAX_COST]).toBe("1");
    expect(env.KEEP).toBe("yes");
  });
});
