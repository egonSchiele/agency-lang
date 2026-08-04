import { describe, expect, it } from "vitest";

import { projectArtifactField } from "./project.js";

/**
 * These outputs are hashed into durable output ids. A change here forks every
 * record derived from structured data, so these are pinned values, not
 * examples.
 */
describe("projectArtifactField is a wire format", () => {
  it("passes a string through untouched", () => {
    expect(projectArtifactField("hello")).toBe("hello");
  });

  it("renders a number as JSON", () => {
    expect(projectArtifactField(42)).toBe("42");
  });

  it("renders null as JSON, not as the empty string", () => {
    expect(projectArtifactField(null)).toBe("null");
  });

  it("renders an object with keys in source order", () => {
    expect(projectArtifactField({ b: 1, a: 2 })).toBe('{"b":1,"a":2}');
  });

  it("renders an array as JSON", () => {
    expect(projectArtifactField(["a", 1])).toBe('["a",1]');
  });
});
