import { describe, it, expect, afterEach } from "vitest";
import { Checkpoint } from "./state/checkpointStore.js";
import {
  signCheckpoint,
  verifyCheckpointChecksum,
  CheckpointKeyTooShortError,
} from "./checkpointChecksum.js";

const KEY = "0123456789abcdef0123456789abcdef"; // 32 bytes
const ROTATED_KEY = "ffffffffffffffffffffffffffffffff";

function makeCheckpoint(): Checkpoint {
  return new Checkpoint({
    id: 1,
    nodeId: "start",
    moduleId: "mod.agency",
    scopeName: "main",
    stepPath: "0",
    stack: {
      stack: [{ args: {}, locals: { x: 1 }, threads: null, step: 0, scopeName: "main" }],
      mode: "serialize",
      other: {},
      deserializeStackLength: 0,
      nodesTraversed: [],
    },
    globals: { store: {}, initializedModules: [] },
  });
}

/** A checkpoint carrying the fields PR #977 added to the schemas (guards,
 *  cost, savedDraft, branches). The verify side goes through the zod schemas,
 *  so any toJSON field missing from its schema would turn into a false
 *  "tampered" verdict — this fixture pins the round trip. */
function makeRichCheckpoint(): Checkpoint {
  return new Checkpoint({
    id: 2,
    nodeId: "start",
    moduleId: "mod.agency",
    scopeName: "main",
    stepPath: "0",
    stack: {
      stack: [
        {
          args: {},
          locals: {},
          threads: null,
          step: 1,
          scopeName: "main",
          savedDraft: { value: "draft" },
          branches: {
            fork_1_0: {
              stack: {
                stack: [],
                mode: "serialize",
                other: {},
                deserializeStackLength: 0,
                nodesTraversed: [],
              },
              interruptId: "int-1",
              result: { result: "done" },
              activeStack: ["t1"],
            },
          },
        },
      ],
      mode: "serialize",
      other: {},
      deserializeStackLength: 0,
      nodesTraversed: [],
      localCost: 2.25,
      localTokens: 100,
      guards: [{ kind: "cost", costLimit: 10, spent: 4, guardId: "g1", label: "budget" }],
      inheritedGuardCount: 0,
      inheritedTimeGuards: [{ kind: "time", timeLimit: 5000, elapsedMs: 1200, guardId: "g2" }],
    },
    globals: { store: {}, initializedModules: [] },
  });
}

afterEach(() => {
  delete process.env.AGENCY_CHECKPOINT_KEY;
  delete process.env.AGENCY_CHECKPOINT_KEY_OLD;
});

describe("checkpoint checksum", () => {
  it("signs then verifies true", () => {
    process.env.AGENCY_CHECKPOINT_KEY = KEY;
    const checkpoint = makeCheckpoint();
    signCheckpoint(checkpoint);
    expect(verifyCheckpointChecksum(checkpoint)).toBe(true);
  });

  it("verify is false when a local changed after signing", () => {
    process.env.AGENCY_CHECKPOINT_KEY = KEY;
    const checkpoint = makeCheckpoint();
    signCheckpoint(checkpoint);
    checkpoint.stack.stack[0].locals.x = 999;
    expect(verifyCheckpointChecksum(checkpoint)).toBe(false);
  });

  it("verify is false under a different key", () => {
    process.env.AGENCY_CHECKPOINT_KEY = KEY;
    const checkpoint = makeCheckpoint();
    signCheckpoint(checkpoint);
    process.env.AGENCY_CHECKPOINT_KEY = ROTATED_KEY;
    expect(verifyCheckpointChecksum(checkpoint)).toBe(false);
  });

  it("verify is false when the signature is stripped (downgrade guard)", () => {
    process.env.AGENCY_CHECKPOINT_KEY = KEY;
    const checkpoint = makeCheckpoint();
    signCheckpoint(checkpoint);
    checkpoint.signature = undefined;
    expect(verifyCheckpointChecksum(checkpoint)).toBe(false);
  });

  it("key order does not matter (parse + re-stringify round trip verifies)", () => {
    process.env.AGENCY_CHECKPOINT_KEY = KEY;
    const checkpoint = makeCheckpoint();
    signCheckpoint(checkpoint);
    const revived = Checkpoint.fromJSON(JSON.parse(JSON.stringify(checkpoint.toJSON())))!;
    expect(verifyCheckpointChecksum(revived)).toBe(true);
  });

  it("a RICH checkpoint survives the external zod round trip and still verifies", () => {
    process.env.AGENCY_CHECKPOINT_KEY = KEY;
    const checkpoint = makeRichCheckpoint();
    signCheckpoint(checkpoint);
    const revived = Checkpoint.fromJSON(JSON.parse(JSON.stringify(checkpoint.toJSON())))!;
    expect(verifyCheckpointChecksum(revived)).toBe(true);
  });

  it("no key: signCheckpoint leaves signature absent and verify returns false, neither throws", () => {
    const checkpoint = makeCheckpoint();
    expect(() => signCheckpoint(checkpoint)).not.toThrow();
    expect(checkpoint.signature).toBeUndefined();
    expect(verifyCheckpointChecksum(checkpoint)).toBe(false);
  });

  it("a present but too-short key throws CheckpointKeyTooShortError", () => {
    process.env.AGENCY_CHECKPOINT_KEY = "tooshort";
    expect(() => signCheckpoint(makeCheckpoint())).toThrow(CheckpointKeyTooShortError);
  });

  it("a checkpoint signed under a retired key still verifies via AGENCY_CHECKPOINT_KEY_OLD", () => {
    process.env.AGENCY_CHECKPOINT_KEY = KEY;
    const checkpoint = makeCheckpoint();
    signCheckpoint(checkpoint);
    // Rotate: the signing key moves to _OLD, a new key takes its place.
    process.env.AGENCY_CHECKPOINT_KEY = ROTATED_KEY;
    process.env.AGENCY_CHECKPOINT_KEY_OLD = KEY;
    expect(verifyCheckpointChecksum(checkpoint)).toBe(true);
    // A key in neither var still fails.
    process.env.AGENCY_CHECKPOINT_KEY_OLD = "00000000000000000000000000000000";
    expect(verifyCheckpointChecksum(checkpoint)).toBe(false);
  });

  it("an edited-then-resigned checkpoint verifies true", () => {
    process.env.AGENCY_CHECKPOINT_KEY = KEY;
    const checkpoint = makeCheckpoint();
    signCheckpoint(checkpoint);
    checkpoint.stack.stack[0].locals.x = 42; // simulate an override edit
    signCheckpoint(checkpoint); // re-sign
    expect(verifyCheckpointChecksum(checkpoint)).toBe(true);
  });
});
