import { describe, expect, it } from "vitest";

import { selectFinalResponse } from "./selectFinalResponse.js";

describe("selectFinalResponse", () => {
  it("reads the last v2 eval output", () => {
    expect(
      selectFinalResponse({
        recordVersion: 2,
        evalOutputs: [
          { value: "first", threadId: "0", tMs: 1 },
          { value: "last", threadId: "0", tMs: 2 },
        ],
      }),
    ).toEqual({ text: "last", missing: false });
  });

  it("reports missing when v2 evalOutputs is empty", () => {
    expect(selectFinalResponse({ recordVersion: 2, evalOutputs: [] })).toEqual({
      text: "",
      missing: true,
    });
  });

  it("preserves the v2 truncated flag", () => {
    expect(
      selectFinalResponse({
        recordVersion: 2,
        evalOutputs: [{ value: "partial", threadId: "0", tMs: 1, truncated: true }],
      }),
    ).toEqual({ text: "partial", truncated: true, missing: false });
  });

  it("stringifies non-string v2 eval output values", () => {
    expect(
      selectFinalResponse({
        recordVersion: 2,
        evalOutputs: [{ value: { reply: "hello" }, threadId: "0", tMs: 1 }],
      }),
    ).toEqual({ text: '{"reply":"hello"}', missing: false });
  });

  it("reads legacy v1 finalResponse", () => {
    expect(selectFinalResponse({ recordVersion: 1, finalResponse: "legacy" })).toEqual({
      text: "legacy",
      missing: false,
    });
  });

  it("reports missing for legacy null finalResponse", () => {
    expect(selectFinalResponse({ recordVersion: 1, finalResponse: null })).toEqual({
      text: "",
      missing: true,
    });
  });

  it("reports missing for legacy undefined finalResponse", () => {
    expect(selectFinalResponse({ recordVersion: 1, finalResponse: undefined })).toEqual({
      text: "",
      missing: true,
    });
  });

  it("reports missing when neither supported field is present", () => {
    expect(selectFinalResponse({ recordVersion: 99 })).toEqual({
      text: "",
      missing: true,
    });
  });
});
