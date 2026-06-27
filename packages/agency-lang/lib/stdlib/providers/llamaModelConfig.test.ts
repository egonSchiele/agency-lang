import { describe, it, expect } from "vitest";
import { splitModelPath } from "./llamaModelConfig.js";

describe("splitModelPath", () => {
  it("splits an absolute gguf path", () => {
    expect(splitModelPath("/home/u/models/qwen.gguf")).toEqual({
      model: "qwen.gguf",
      llamaCppModelDir: "/home/u/models",
    });
  });
  it("handles a bare filename", () => {
    expect(splitModelPath("qwen.gguf")).toEqual({ model: "qwen.gguf", llamaCppModelDir: "." });
  });
});
