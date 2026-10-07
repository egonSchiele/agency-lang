import { describe, it, expect, afterEach } from "vitest";
import { Checkpoint, CheckpointStore, type CheckpointJSON } from "./state/checkpointStore.js";
import {
  signCheckpoint,
  verifyCheckpointChecksum,
  constantTimeEqual,
  CheckpointKeyTooShortError,
} from "./checkpointChecksum.js";
import { memoryHost } from "../host/memoryHost.js";
import { defaultHost } from "#default-host";
import { RuntimeContext } from "./state/context.js";

// The default host's settings read the environment, which these tests set.
const env = defaultHost().settings;

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

/** Carries guards, cost, savedDraft, and branches: the verify side goes
 *  through the zod schemas, so a toJSON field missing from its schema would
 *  read as tampered. */
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
    signCheckpoint(checkpoint, env);
    expect(verifyCheckpointChecksum(checkpoint)).toBe(true);
  });

  it("verify is false when a local changed after signing", () => {
    process.env.AGENCY_CHECKPOINT_KEY = KEY;
    const checkpoint = makeCheckpoint();
    signCheckpoint(checkpoint, env);
    checkpoint.stack.stack[0].locals.x = 999;
    expect(verifyCheckpointChecksum(checkpoint)).toBe(false);
  });

  it("verify is false under a different key", () => {
    process.env.AGENCY_CHECKPOINT_KEY = KEY;
    const checkpoint = makeCheckpoint();
    signCheckpoint(checkpoint, env);
    process.env.AGENCY_CHECKPOINT_KEY = ROTATED_KEY;
    expect(verifyCheckpointChecksum(checkpoint)).toBe(false);
  });

  it("verify is false when the signature is stripped (downgrade guard)", () => {
    process.env.AGENCY_CHECKPOINT_KEY = KEY;
    const checkpoint = makeCheckpoint();
    signCheckpoint(checkpoint, env);
    checkpoint.signature = undefined;
    expect(verifyCheckpointChecksum(checkpoint)).toBe(false);
  });

  it("key order does not matter (parse + re-stringify round trip verifies)", () => {
    process.env.AGENCY_CHECKPOINT_KEY = KEY;
    const checkpoint = makeCheckpoint();
    signCheckpoint(checkpoint, env);
    const revived = Checkpoint.fromJSON(JSON.parse(JSON.stringify(checkpoint.toJSON())))!;
    expect(verifyCheckpointChecksum(revived)).toBe(true);
  });

  it("a RICH checkpoint survives the external zod round trip and still verifies", () => {
    process.env.AGENCY_CHECKPOINT_KEY = KEY;
    const checkpoint = makeRichCheckpoint();
    signCheckpoint(checkpoint, env);
    const revived = Checkpoint.fromJSON(JSON.parse(JSON.stringify(checkpoint.toJSON())))!;
    expect(verifyCheckpointChecksum(revived)).toBe(true);
  });

  it("no key: signCheckpoint leaves signature absent and verify returns false, neither throws", () => {
    const checkpoint = makeCheckpoint();
    expect(() => signCheckpoint(checkpoint, env)).not.toThrow();
    expect(checkpoint.signature).toBeUndefined();
    expect(verifyCheckpointChecksum(checkpoint)).toBe(false);
  });

  it("a present but too-short key throws CheckpointKeyTooShortError", () => {
    process.env.AGENCY_CHECKPOINT_KEY = "tooshort";
    expect(() => signCheckpoint(makeCheckpoint(), env)).toThrow(CheckpointKeyTooShortError);
  });

  it("a checkpoint signed under a retired key still verifies via AGENCY_CHECKPOINT_KEY_OLD", () => {
    process.env.AGENCY_CHECKPOINT_KEY = KEY;
    const checkpoint = makeCheckpoint();
    signCheckpoint(checkpoint, env);
    // Rotate: the signing key moves to _OLD, a new key takes its place.
    process.env.AGENCY_CHECKPOINT_KEY = ROTATED_KEY;
    process.env.AGENCY_CHECKPOINT_KEY_OLD = KEY;
    expect(verifyCheckpointChecksum(checkpoint)).toBe(true);
    // A key in neither var still fails.
    process.env.AGENCY_CHECKPOINT_KEY_OLD = "00000000000000000000000000000000";
    expect(verifyCheckpointChecksum(checkpoint)).toBe(false);
  });

  it("signs and verifies a PLAIN JSON checkpoint (the external resume shape)", () => {
    // The external resume path carries parsed JSON, not a Checkpoint instance.
    process.env.AGENCY_CHECKPOINT_KEY = KEY;
    const instance = makeCheckpoint();
    signCheckpoint(instance, env);
    const plain = JSON.parse(JSON.stringify(instance.toJSON()));
    expect(verifyCheckpointChecksum(plain)).toBe(true);
    plain.stack.stack[0].locals.x = 7;
    signCheckpoint(plain, env);
    expect(verifyCheckpointChecksum(plain)).toBe(true);
  });

  it("an edited-then-resigned checkpoint verifies true", () => {
    process.env.AGENCY_CHECKPOINT_KEY = KEY;
    const checkpoint = makeCheckpoint();
    signCheckpoint(checkpoint, env);
    checkpoint.stack.stack[0].locals.x = 42; // simulate an override edit
    signCheckpoint(checkpoint, env); // re-sign
    expect(verifyCheckpointChecksum(checkpoint)).toBe(true);
  });

  it("still verifies a checksum made with Node's createHmac", () => {
    // The checksum below was computed with Node's `createHmac("sha256", KEY)`
    // over the canonical string of this exact checkpoint, so a checkpoint
    // signed by any build of the signer keeps verifying.
    process.env.AGENCY_CHECKPOINT_KEY = KEY;
    const plain: CheckpointJSON = {
      id: 7,
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
      label: null,
      pinned: false,
      signature: "1546bf5e035066194bb8e5eba743e0ae8a7cbd8989cebb9840b1e62e70857984",
    };
    expect(verifyCheckpointChecksum(plain)).toBe(true);
    plain.signature = plain.signature!.toUpperCase();
    expect(verifyCheckpointChecksum(plain)).toBe(true);
    plain.signature = "1546bf5e035066194bb8e5eba743e0ae8a7cbd8989cebb9840b1e62e70857988";
    expect(verifyCheckpointChecksum(plain)).toBe(false);
  });

  it("reads the key from the settings it is given, not the environment", () => {
    // No key in the environment; the run's host carries one.
    const host = memoryHost({ variables: { AGENCY_CHECKPOINT_KEY: KEY } });
    const checkpoint = makeCheckpoint();
    signCheckpoint(checkpoint, host.settings);
    expect(checkpoint.signature).toBeDefined();
    expect(verifyCheckpointChecksum(checkpoint, host.settings)).toBe(true);
    // The default host, which a caller outside any run gets, has no key.
    expect(verifyCheckpointChecksum(checkpoint)).toBe(false);
  });

  it("a checkpoint made inside a run is signed under that run's host", async () => {
    const host = memoryHost({ variables: { AGENCY_CHECKPOINT_KEY: KEY } });
    const ctx = new RuntimeContext({
      statelogConfig: {
        host: "https://example.com",
        apiKey: "test-api-key",
        projectId: "test-project",
        debugMode: false,
      },
      smoltalkDefaults: {},
      dirname: "/",
      host,
    });
    const execCtx = await ctx.createExecutionContext({ runId: "signed" });
    execCtx.stateStack.nodesTraversed = ["start"];
    const checkpoint = Checkpoint.fromStateStack(execCtx.stateStack, execCtx, {
      moduleId: "mod.agency",
      scopeName: "main",
      stepPath: "0",
    });
    expect(verifyCheckpointChecksum(checkpoint, host.settings)).toBe(true);
    expect(verifyCheckpointChecksum(checkpoint)).toBe(false);
  });
});

describe("constantTimeEqual", () => {
  it("compares whole strings", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "ab")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
  });
});

describe("re-signing on the post-creation edit paths", () => {
  afterEach(() => {
    delete process.env.AGENCY_CHECKPOINT_KEY;
  });

  it("a pinned checkpoint still verifies (pin re-signs)", () => {
    process.env.AGENCY_CHECKPOINT_KEY = KEY;
    const store = new CheckpointStore();
    const checkpoint = makeCheckpoint();
    signCheckpoint(checkpoint, env);
    store.add(checkpoint);
    store.pin(checkpoint.id, "pinned-label", env);
    expect(store.get(checkpoint.id)!.pinned).toBe(true);
    expect(verifyCheckpointChecksum(store.get(checkpoint.id)!)).toBe(true);
  });

  it("a clone with a new id still verifies (clone re-signs)", () => {
    process.env.AGENCY_CHECKPOINT_KEY = KEY;
    const checkpoint = makeCheckpoint();
    signCheckpoint(checkpoint, env);
    const copy = checkpoint.clone({ id: 999 }, env);
    expect(copy.id).toBe(999);
    expect(verifyCheckpointChecksum(copy)).toBe(true);
  });
});
