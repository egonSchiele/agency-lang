import { describe, expect, it } from "vitest";
import { memoryHost } from "@/host/memoryHost.js";
import { removeHeldCheckpoint, saveHeldCheckpoint } from "./heldCheckpoint.js";
import { interrupt } from "./interrupts.js";
import type { Interrupt } from "./interrupts.js";
import { Checkpoint } from "./state/checkpointStore.js";

function held(traceId?: string): Interrupt {
  return {
    ...interrupt({ effect: "test::ask", message: "?", data: {}, origin: "t", runId: "r" }),
    checkpoint: new Checkpoint({
      id: 0,
      nodeId: "main",
      stack: {
        stack: [],
        mode: "serialize",
        other: {},
        deserializeStackLength: 0,
        nodesTraversed: [],
      },
      globals: { store: {}, initializedModules: [] },
      traceId,
    }),
  };
}

const host = () => memoryHost({ variables: { AGENCY_HOME: "/home/me/.agency" } });

describe("a held checkpoint's file", () => {
  it("is named for the trace and the process, and holds the checkpoint", async () => {
    const h = host();
    const file = await saveHeldCheckpoint([held("trace-9")], h);
    expect(file).toBe(`/home/me/.agency/held/trace-9-${h.system.processId()}.json`);
    const text = new TextDecoder().decode(h.state.files[file]);
    expect(Checkpoint.fromJSON(JSON.parse(text))?.traceId).toBe("trace-9");
  });

  it("gets a made-up name when the checkpoint has no trace id", async () => {
    const h = host();
    const file = await saveHeldCheckpoint([held()], h);
    expect(file).toMatch(/\/held\/.+-\d+\.json$/);
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

  it("is removed by removeHeldCheckpoint, which refuses a path outside the folder", async () => {
    const h = memoryHost({
      variables: { AGENCY_HOME: "/home/me/.agency" },
      files: { "/home/me/notes.json": "keep" },
    });
    const file = await saveHeldCheckpoint([held("trace-9")], h);
    await expect(removeHeldCheckpoint("/home/me/notes.json", h)).rejects.toThrow(
      "is not a file in",
    );
    await expect(removeHeldCheckpoint("/home/me/.agency/held/../../notes.json", h)).rejects.toThrow(
      "is not a file in",
    );
    expect(h.state.files["/home/me/notes.json"]).toBeDefined();
    await removeHeldCheckpoint(file, h);
    expect(h.state.files[file]).toBeUndefined();
  });
});
