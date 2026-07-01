import { describe, it, expect } from "vitest";
import { _listHostedModels } from "./llm.js";

// No mock: exercises the REAL smoltalk catalog end-to-end, so a smoltalk
// upgrade that changes getAllModels' shape or stops returning text models is
// caught here (this is the automated counterpart to the Task 0 upgrade check).
// Name-agnostic on purpose — no pinned model names — so ordinary catalog/price
// churn on a dependency bump does NOT break it.
describe("hosted catalog — real smoltalk integration", () => {
  it("returns mapped text models with sane fields", () => {
    const all = _listHostedModels();
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((model) => model.name.length > 0)).toBe(true);
    expect(all.every((model) => model.contextWindow > 0)).toBe(true);
  });
});
