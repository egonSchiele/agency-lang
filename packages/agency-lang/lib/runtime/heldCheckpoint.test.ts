import { describe, expect, it } from "vitest";
import { AGENCY_MAX_COST, AGENCY_MAX_TIME, AGENCY_RUN_POLICY } from "@/constants.js";
import { memoryHost } from "@/host/memoryHost.js";
import { signCheckpoint, verifyCheckpointChecksum } from "./checkpointChecksum.js";
import { removeHeldCheckpoint, resumeCommand, saveHeldCheckpoint } from "./heldCheckpoint.js";
import { interrupt } from "./interrupts.js";
import type { Interrupt } from "./interrupts.js";
import { nativeTypeReplacer, nativeTypeReviver } from "./revivers/index.js";
import { Checkpoint } from "./state/checkpointStore.js";

function held(traceId?: string, other: Record<string, unknown> = {}): Interrupt {
  return {
    ...interrupt({ effect: "test::ask", message: "?", data: {}, origin: "t", runId: "r" }),
    checkpoint: new Checkpoint({
      id: 0,
      nodeId: "main",
      stack: {
        stack: [],
        mode: "serialize",
        other,
        deserializeStackLength: 0,
        nodesTraversed: [],
      },
      globals: { store: {}, initializedModules: [] },
      traceId,
    }),
  };
}

const READ_OK = JSON.stringify({ "std::read": [{ action: "approve" }] });
const host = (variables: Record<string, string> = {}) =>
  memoryHost({ variables: { AGENCY_HOME: "/home/me/.agency", ...variables } });
const text = (h: ReturnType<typeof host>, file: string) =>
  new TextDecoder().decode(h.state.files[file]);

describe("a held checkpoint's file", () => {
  it("is named for the trace and the process, and holds the checkpoint", async () => {
    const h = host();
    const files = await saveHeldCheckpoint([held("trace-9")], h);
    expect(files).toEqual({
      checkpoint: `/home/me/.agency/held/trace-9-${h.system.processId()}.json`,
      policy: null,
    });
    expect(Checkpoint.fromJSON(JSON.parse(text(h, files.checkpoint)))?.traceId).toBe("trace-9");
  });

  // A surfaced checkpoint has been through the copy `createReturnObject`
  // makes, which leaves live values in it.
  it("keeps a Date and a Set the program holds", async () => {
    const h = host();
    const when = new Date(86_400_000);
    const surfaced = held("trace-9", { when, seen: new Set(["a"]) });
    surfaced.checkpoint = JSON.parse(
      JSON.stringify(surfaced.checkpoint, nativeTypeReplacer),
      nativeTypeReviver,
    );
    const files = await saveHeldCheckpoint([surfaced], h);
    const saved = Checkpoint.fromJSON(JSON.parse(text(h, files.checkpoint)));
    const other = JSON.parse(JSON.stringify(saved?.stack.other), nativeTypeReviver);
    expect(other.when).toEqual(when);
    expect(other.seen).toEqual(new Set(["a"]));
  });

  // The checksum is made over live values and checked over the saved
  // form, so both must hash the same.
  it("still verifies after the save when it was signed, and not when a Set in it was edited", async () => {
    const h = host({ AGENCY_CHECKPOINT_KEY: "k".repeat(32) });
    const surfaced = held("trace-9", { when: new Date(86_400_000), seen: new Set(["a"]) });
    signCheckpoint(surfaced.checkpoint!, h.settings);
    surfaced.checkpoint = JSON.parse(
      JSON.stringify(surfaced.checkpoint, nativeTypeReplacer),
      nativeTypeReviver,
    );
    const files = await saveHeldCheckpoint([surfaced], h);
    const saved = text(h, files.checkpoint);
    const verifies = (json: string) =>
      verifyCheckpointChecksum(Checkpoint.fromJSON(JSON.parse(json))!, h.settings);
    expect(verifies(saved)).toBe(true);
    expect(saved).toContain('["a"]');
    expect(verifies(saved.replace('["a"]', '["b"]'))).toBe(false);
  });

  it("gets a made-up name when the checkpoint has no trace id", async () => {
    const h = host();
    const files = await saveHeldCheckpoint([held()], h);
    expect(files.checkpoint).toMatch(/\/held\/.+-\d+\.json$/);
  });

  it("is never written over: a second save under the same name fails", async () => {
    const h = host();
    await saveHeldCheckpoint([held("trace-9")], h);
    await expect(saveHeldCheckpoint([held("trace-9")], h)).rejects.toThrow();
  });

  it("refuses interrupts that carry no checkpoint", async () => {
    const bare = interrupt({ effect: "e", message: "?", data: {}, origin: "t", runId: "r" });
    await expect(saveHeldCheckpoint([bare], host())).rejects.toThrow("no checkpoint");
  });

  it("has the run's policy saved beside it when the policy has rules", async () => {
    const h = host({ [AGENCY_RUN_POLICY]: READ_OK });
    const files = await saveHeldCheckpoint([held("trace-9")], h);
    expect(files.policy).toBe(`/home/me/.agency/held/trace-9-${h.system.processId()}.policy.json`);
    expect(text(h, files.policy!)).toBe(READ_OK);
  });

  // A checkpoint holds the program's whole state. A save that fails
  // half way must not leave one, or a policy, that nothing will remove.
  it("leaves nothing behind when either write fails", async () => {
    // Each write refuses to replace a file, so a file already at one of
    // the two names makes that write fail.
    for (const [taken, other] of [
      [".policy.json", ".json"],
      [".json", ".policy.json"],
    ]) {
      const h = host({ [AGENCY_RUN_POLICY]: READ_OK });
      const name = (end: string) => `/home/me/.agency/held/trace-9-${h.system.processId()}${end}`;
      h.state.files[name(taken!)] = new TextEncoder().encode("in the way");
      await expect(saveHeldCheckpoint([held("trace-9")], h)).rejects.toThrow();
      expect(h.state.files[name(other!)]).toBeUndefined();
    }
  });

  it("has no policy file for a policy with no rules", async () => {
    const files = await saveHeldCheckpoint([held("trace-9")], host({ [AGENCY_RUN_POLICY]: "{}" }));
    expect(files.policy).toBeNull();
  });

  it("is removed with its policy by removeHeldCheckpoint, which refuses a path outside the folder", async () => {
    const h = memoryHost({
      variables: { AGENCY_HOME: "/home/me/.agency", [AGENCY_RUN_POLICY]: READ_OK },
      files: { "/home/me/notes.json": "keep" },
    });
    const files = await saveHeldCheckpoint([held("trace-9")], h);
    for (const outside of ["/home/me/notes.json", "/home/me/.agency/held/../../notes.json"]) {
      await expect(removeHeldCheckpoint({ ...files, policy: outside }, h)).rejects.toThrow(
        "is not a file in",
      );
      await expect(removeHeldCheckpoint({ checkpoint: outside, policy: null }, h)).rejects.toThrow(
        "is not a file in",
      );
    }
    expect(h.state.files["/home/me/notes.json"]).toBeDefined();
    expect(h.state.files[files.checkpoint]).toBeDefined();
    await removeHeldCheckpoint(files, h);
    expect(h.state.files[files.checkpoint]).toBeUndefined();
    expect(h.state.files[files.policy!]).toBeUndefined();
  });
});

describe("resumeCommand", () => {
  const files = { checkpoint: "/h/held/t-1.json", policy: null };

  it("names the checkpoint and keeps the program waiting", () => {
    expect(resumeCommand(files, host().settings)).toBe(
      "agency resume /h/held/t-1.json <program> --wait-for-response",
    );
  });

  // A checkpoint holds neither, so a resume without the flags would run
  // with no rules and no limits.
  it("carries the policy and the limits the run was started with", () => {
    const settings = host({ [AGENCY_MAX_COST]: "2", [AGENCY_MAX_TIME]: "600000" }).settings;
    expect(resumeCommand({ ...files, policy: "/h/held/t-1.policy.json" }, settings)).toBe(
      "agency resume /h/held/t-1.json <program> --wait-for-response " +
        "--policy /h/held/t-1.policy.json --max-cost 2 --max-time 600000ms",
    );
  });

  it("quotes a path a shell would split", () => {
    const spaced = {
      checkpoint: "/h/Agency Data/held/t-1.json",
      policy: "/h/it's/held/t-1.policy.json",
    };
    expect(resumeCommand(spaced, host().settings)).toBe(
      "agency resume '/h/Agency Data/held/t-1.json' <program> --wait-for-response " +
        "--policy '/h/it'\\''s/held/t-1.policy.json'",
    );
  });

  it("leaves out a limit that is switched off", () => {
    const settings = host({ [AGENCY_MAX_COST]: "-1", [AGENCY_MAX_TIME]: "0" }).settings;
    expect(resumeCommand(files, settings)).not.toContain("--max");
  });
});
