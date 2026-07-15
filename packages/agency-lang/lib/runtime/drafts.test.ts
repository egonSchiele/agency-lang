import { describe, it, expect } from "vitest";
import { StateStack, State } from "./state/stateStack.js";
import { failure, success } from "./result.js";
import {
  writeDraft,
  writeCallerDraft,
  draftRegionStart,
  readOutermostDraft,
  sweepDrafts,
  salvageOwnTrip,
  __clearTopFrameDraft,
} from "./drafts.js";

function stackWithFrames(n: number): StateStack {
  const s = new StateStack();
  for (let i = 0; i < n; i++) s.stack.push(new State());
  return s;
}

describe("draft store", () => {
  it("reads the outermost (shallowest) draft at or above the region", () => {
    const s = stackWithFrames(4);
    writeDraft(s, 2, "code");
    writeDraft(s, 3, "verify");
    expect(readOutermostDraft(s, 1)?.value).toBe("code");
  });

  it("last-wins per frame", () => {
    const s = stackWithFrames(3);
    writeDraft(s, 2, "first");
    writeDraft(s, 2, "second");
    expect(readOutermostDraft(s, 0)?.value).toBe("second");
  });

  it("returns undefined when nothing is at or above the region", () => {
    const s = stackWithFrames(3);
    writeDraft(s, 1, "shallow");
    expect(readOutermostDraft(s, 2)).toBeUndefined();
  });

  it("sweep deletes every draft at depth >= region", () => {
    const s = stackWithFrames(4);
    writeDraft(s, 1, "keep");
    writeDraft(s, 2, "drop");
    sweepDrafts(s, 2);
    expect(readOutermostDraft(s, 0)?.value).toBe("keep");
    expect(readOutermostDraft(s, 2)).toBeUndefined();
  });

  it("clearTopFrameDraft clears the top frame's draft only", () => {
    const s = stackWithFrames(3); // top index = 2
    writeDraft(s, 1, "caller");
    writeDraft(s, 2, "top");
    __clearTopFrameDraft(s);
    expect(readOutermostDraft(s, 0)?.value).toBe("caller");
    expect(readOutermostDraft(s, 2)).toBeUndefined();
  });

  it("writeCallerDraft keys the caller frame (one below the helper's top)", () => {
    const s = stackWithFrames(4); // helper 'top' = index 3, caller = index 2
    writeCallerDraft(s, "from-caller");
    expect(readOutermostDraft(s, 2)?.value).toBe("from-caller");
    expect(readOutermostDraft(s, 3)).toBeUndefined();
  });

  it("writeCallerDraft is a no-op with no caller (module/global scope)", () => {
    const s = stackWithFrames(1); // callerDepth = -1
    writeCallerDraft(s, "x");
    expect(readOutermostDraft(s, 0)).toBeUndefined();
  });

  it("deep-clones on save (later mutation does not change the salvage)", () => {
    const s = stackWithFrames(3);
    const report = { text: "v1" };
    writeCallerDraft(s, report); // caller = index 1
    report.text = "v2";
    expect(readOutermostDraft(s, 1)?.value).toEqual({ text: "v1" });
  });

  it("draftRegionStart marks the current stack depth", () => {
    const s = stackWithFrames(3);
    expect(draftRegionStart(s)).toBe(3);
  });

  it("salvageOwnTrip salvages ONLY on this guard's own trip", () => {
    const s = stackWithFrames(3);
    writeDraft(s, 2, "best");
    const ownTrip = failure({ type: "guardFailure", guardId: "g1" });
    expect(salvageOwnTrip(s, 0, ["g1"], ownTrip)).toEqual(success("best"));
  });

  it("salvageOwnTrip does NOT salvage a propagated (foreign-id) failure", () => {
    const s = stackWithFrames(3);
    writeDraft(s, 2, "best");
    const foreign = failure({ type: "guardFailure", guardId: "inner" });
    expect(salvageOwnTrip(s, 0, ["g1"], foreign)).toBe(foreign);
    expect(readOutermostDraft(s, 0)).toBeUndefined(); // region still swept
  });

  it("salvageOwnTrip passes interrupts through WITHOUT sweeping", () => {
    const s = stackWithFrames(3);
    writeDraft(s, 2, "best");
    const interrupts = [{ type: "interrupt", id: "i1" }] as any;
    expect(salvageOwnTrip(s, 0, ["g1"], interrupts)).toBe(interrupts);
    expect(readOutermostDraft(s, 0)?.value).toBe("best"); // NOT swept
  });

  it("survives StateStack serialization round-trip", () => {
    const s = stackWithFrames(3);
    writeDraft(s, 2, { report: "partial" });
    const restored = StateStack.fromJSON(JSON.parse(JSON.stringify(s.toJSON())));
    expect(readOutermostDraft(restored, 0)?.value).toEqual({ report: "partial" });
  });

  it("tolerates a stack with no drafts", () => {
    const s = stackWithFrames(2);
    expect(readOutermostDraft(s, 0)).toBeUndefined();
    sweepDrafts(s, 0);
    __clearTopFrameDraft(s);
    __clearTopFrameDraft(undefined);
  });
});
