import { describe, expect, it } from "vitest";

import { findRow } from "./detailTarget.js";
import { outlineLines } from "./outlineText.js";
import { hiddenByDefault, storyOutline } from "./story.js";
import { sampleRunForest } from "./storyFixture.js";

const trace = sampleRunForest()[0];
const DEFAULT = { approvals: false, admin: false };

describe("outlineLines", () => {
  it("is the story outline's rows in order, approvals hidden, with depths and addresses", () => {
    const expected = storyOutline(trace, { admin: false }).filter((row) => !hiddenByDefault(row));
    const lines = outlineLines(trace, DEFAULT);
    expect(lines.map((line) => [line.rowId, line.depth])).toEqual(
      expected.map((row) => [row.id, row.depth]),
    );
    expect(lines.every((line) => line.address === `${trace.traceId}/${line.rowId}`)).toBe(true);
  });

  it("prints rows whose ids all resolve with findRow", () => {
    const lines = outlineLines(trace, { approvals: true, admin: true });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.filter((line) => findRow(trace, line.rowId) === undefined)).toEqual([]);
  });

  it("hides approved interrupts until approvals is on, and keeps rejected ones", () => {
    const outcomes = (approvals: boolean) =>
      outlineLines(trace, { approvals, admin: false })
        .filter((line) => line.kind === "interrupt")
        .map((line) => line.header.split(" · ")[2]);
    expect(outcomes(false)).not.toContain("approved");
    expect(outcomes(false)).toContain("rejected");
    expect(outcomes(true)).toContain("approved");
  });

  it("admin adds the handler decisions", () => {
    const machinery = (admin: boolean) =>
      outlineLines(trace, { approvals: true, admin }).filter((line) => line.kind === "machinery");
    expect(machinery(false)).toEqual([]);
    expect(machinery(true).length).toBeGreaterThan(0);
  });
});
