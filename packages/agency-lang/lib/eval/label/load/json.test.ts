import { describe, expect, it } from "vitest";

import { loadJsonArray, type LoadJsonArrayArgs } from "./json.js";
import { DEFAULT_MAX_INGEST_BYTES, IngestSourceError } from "./types.js";

function load(over: Partial<LoadJsonArrayArgs> = {}) {
  return loadJsonArray({
    itemKey: "answers.json",
    text: '["a","b"]',
    source: "pasted",
    constantFields: {},
    maxBytes: DEFAULT_MAX_INGEST_BYTES,
    ...over,
  });
}

describe("loadJsonArray", () => {
  it("makes each element one record's output field", () => {
    expect(load().occurrences.map((o) => o.fields.output)).toEqual(["a", "b"]);
  });

  it("keys each occurrence by its index, so equal strings stay separate observations", () => {
    const batch = load({ text: '["same","same"]' });
    const indices = batch.occurrences.map((o) =>
      o.origin.kind === "json" ? o.origin.itemIndex : -1,
    );
    expect(indices).toEqual([0, 1]);
  });

  it("includes the document key so two JSON files under one source remain distinct", () => {
    const left = load({ itemKey: "a.json", text: '["same"]' });
    const right = load({ itemKey: "b.json", text: '["same"]' });
    const keyOf = (batch: ReturnType<typeof load>) =>
      batch.occurrences[0].origin.kind === "json" ? batch.occurrences[0].origin.itemKey : "?";
    expect(keyOf(left)).toBe("a.json");
    expect(keyOf(right)).toBe("b.json");
  });

  it("merges constant fields into every record", () => {
    expect(load({ constantFields: { task: "Summarize" } }).occurrences[0].fields).toEqual({
      task: "Summarize",
      output: "a",
    });
  });

  it("applies the same eligibility policy as files", () => {
    const batch = load({ text: '["","real"]' });
    expect(batch.occurrences).toHaveLength(1);
    expect(batch.skips).toEqual([{ item: "answers.json[0]", reason: "empty" }]);
  });

  it("keeps the original index in a skip, so the report points at the right element", () => {
    const batch = load({ text: '["real","  ","also real"]' });
    expect(batch.skips).toEqual([{ item: "answers.json[1]", reason: "empty" }]);
  });

  it("skips an element over the cap", () => {
    expect(load({ text: '["xxxxxxxxxx"]', maxBytes: 2 }).skips).toEqual([
      { item: "answers.json[0]", reason: "too-large" },
    ]);
  });

  it("rejects a non-string element by index rather than coercing it", () => {
    expect(() => load({ text: '["a", 42]' })).toThrow(/element 1 is a number/);
  });

  it("names the type of a nested object element", () => {
    expect(() => load({ text: '[{"a":1}]' })).toThrow(/element 0 is an object/);
  });

  it("rejects a top-level object", () => {
    expect(() => load({ text: '{"a":1}' })).toThrow(/top-level array of strings/);
  });

  it("rejects invalid JSON, quoting the parse error", () => {
    expect(() => load({ text: "[" })).toThrow(IngestSourceError);
  });

  it("accepts an empty array, leaving the zero-record error to the caller", () => {
    // The loader's job is to report what it found; deciding that nothing is an
    // error belongs to ingest, which knows about every source shape.
    expect(load({ text: "[]" }).occurrences).toEqual([]);
  });
});
