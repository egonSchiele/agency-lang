import { describe, expect, test } from "vitest";
import { withRootCarriers } from "./childEnv.js";

describe("withRootCarriers", () => {
  test("clears every inherited carrier, then sets only what this invocation resolved", () => {
    const inherited = {
      AGENCY_RUN_POLICY: "stale",
      AGENCY_RUN_POLICY_INTERACTIVE: "1",
      AGENCY_MAX_COST: "9",
      AGENCY_MAX_TIME: "9",
      PATH: "/bin",
    };
    expect(withRootCarriers(inherited, {})).toEqual({ PATH: "/bin" });
    expect(
      withRootCarriers(inherited, {
        policy: { policyJson: "{}", interactive: true },
        budget: { maxCost: "5" },
      }),
    ).toEqual({
      PATH: "/bin",
      AGENCY_RUN_POLICY: "{}",
      AGENCY_RUN_POLICY_INTERACTIVE: "1",
      AGENCY_MAX_COST: "5",
    });
  });

  test("clears stale resume carriers and sets them only for resume", () => {
    const inherited = {
      AGENCY_RESUME_FILE: "/stale/checkpoint.json",
      AGENCY_RESUME_OVERRIDES: '{"locals":{"stale":true}}',
      AGENCY_RESUME_EDITS: '[{"op":"appendMessage","text":"stale"}]',
      AGENCY_RESUME_FORCE: "1",
      PATH: "/bin",
    };

    expect(withRootCarriers(inherited, {})).toEqual({ PATH: "/bin" });
    const resume = {
      checkpointFile: "/new/checkpoint.json",
      overridesJson: "{}",
      editsJson: "[]",
      force: true,
    };
    // No edits, no carrier: the child reads an absent variable as none.
    expect(withRootCarriers(inherited, { resume })).toEqual({
      PATH: "/bin",
      AGENCY_RESUME_FILE: "/new/checkpoint.json",
      AGENCY_RESUME_OVERRIDES: "{}",
      AGENCY_RESUME_FORCE: "1",
    });
    const editsJson = '[{"op":"removeTool","tool":"search"}]';
    expect(withRootCarriers(inherited, { resume: { ...resume, editsJson } })).toMatchObject({
      AGENCY_RESUME_EDITS: editsJson,
    });
  });

  test("clears a stale wait flag and held-checkpoint flag, and sets each only when asked", () => {
    const inherited = {
      AGENCY_RUN_POLICY_WAIT: "1",
      AGENCY_SAVE_HELD_CHECKPOINT: "1",
      PATH: "/bin",
    };

    expect(withRootCarriers(inherited, {})).toEqual({ PATH: "/bin" });
    expect(withRootCarriers(inherited, { policy: { policyJson: "{}" } })).toEqual({
      PATH: "/bin",
      AGENCY_RUN_POLICY: "{}",
    });
    expect(
      withRootCarriers(inherited, {
        policy: { policyJson: "{}", waitForResponse: true },
        saveHeldCheckpoint: true,
      }),
    ).toEqual({
      PATH: "/bin",
      AGENCY_RUN_POLICY: "{}",
      AGENCY_RUN_POLICY_WAIT: "1",
      AGENCY_SAVE_HELD_CHECKPOINT: "1",
    });
  });

  test("clears a stale title, seed, and output file, and sets each only when given", () => {
    const inherited = {
      AGENCY_PROCESS_TITLE: "stale",
      AGENCY_SEED_MESSAGES: "/stale/seed.json",
      AGENCY_OUTPUT_FILE: "/stale/out.log",
      PATH: "/bin",
    };

    expect(withRootCarriers(inherited, {})).toEqual({ PATH: "/bin" });
    expect(
      withRootCarriers(inherited, {
        title: "agency run report",
        seedMessages: "-",
        outputFile: "/new/out.log",
      }),
    ).toEqual({
      PATH: "/bin",
      AGENCY_PROCESS_TITLE: "agency run report",
      AGENCY_SEED_MESSAGES: "-",
      AGENCY_OUTPUT_FILE: "/new/out.log",
    });
    expect(withRootCarriers(inherited, { title: "agency run report" })).toEqual({
      PATH: "/bin",
      AGENCY_PROCESS_TITLE: "agency run report",
    });
  });

  // The depth is meant to pass down, so that a chain of spawns is counted.
  test("leaves the spawn depth as it was inherited", () => {
    expect(withRootCarriers({ AGENCY_SPAWN_DEPTH: "2", PATH: "/bin" }, {})).toEqual({
      AGENCY_SPAWN_DEPTH: "2",
      PATH: "/bin",
    });
  });

  test("clears a stale entry node and sets it only when this run names one", () => {
    const inherited = { AGENCY_ENTRY_NODE: "stale", PATH: "/bin" };

    expect(withRootCarriers(inherited, {})).toEqual({ PATH: "/bin" });
    expect(withRootCarriers(inherited, { entryNode: "list" })).toEqual({
      PATH: "/bin",
      AGENCY_ENTRY_NODE: "list",
    });
  });
});
