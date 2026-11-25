import { describe, it, expect } from "vitest";
import { parseHfFileUri, parseHfUri, pickSingleQuantFile } from "../../scripts/genModelHashes.js";
import { CURATED_LOCAL_MODELS } from "./modelCatalog.js";

describe("genModelHashes helpers", () => {
  it("parseHfUri splits hf:user/repo:quant", () => {
    expect(parseHfUri("hf:unsloth/Qwen3.5-2B-GGUF:Q4_K_M")).toEqual({
      user: "unsloth",
      repo: "Qwen3.5-2B-GGUF",
      quant: "Q4_K_M",
    });
  });
  it("parseHfUri returns null for non-hf or file-form uris", () => {
    expect(parseHfUri("https://x/y.gguf")).toBeNull();
    expect(parseHfUri("/abs/m.gguf")).toBeNull();
    expect(parseHfUri("hf:user/repo/file.gguf")).toBeNull(); // file-form, not :quant
  });
  it("parseHfFileUri splits hf:user/repo/file.gguf, subfolder included", () => {
    expect(
      parseHfFileUri("hf:prism-ml/Ternary-Bonsai-2.5-27B-GGUF/Ternary-Bonsai-2.5-27B-Q2_0.gguf"),
    ).toEqual({
      user: "prism-ml",
      repo: "Ternary-Bonsai-2.5-27B-GGUF",
      file: "Ternary-Bonsai-2.5-27B-Q2_0.gguf",
    });
    expect(parseHfFileUri("hf:user/repo/gguf/model.gguf")?.file).toBe("gguf/model.gguf");
    expect(parseHfFileUri("hf:unsloth/Qwen3.5-2B-GGUF:Q4_K_M")).toBeNull();
    expect(parseHfFileUri("hf:user/repo/README.md")).toBeNull();
  });
  it("every curated file-form uri names a file a pin can be minted for", () => {
    for (const [name, info] of Object.entries(CURATED_LOCAL_MODELS)) {
      if (/^hf:[^:]+$/.test(info.uri)) {
        expect(parseHfFileUri(info.uri), name).not.toBeNull();
      }
    }
  });
  it("pickSingleQuantFile returns the lone matching gguf, else null", () => {
    expect(
      pickSingleQuantFile(["README.md", "Model-Q4_K_M.gguf", "Model-Q8_0.gguf"], "Q4_K_M"),
    ).toBe("Model-Q4_K_M.gguf");
    // sharded → more than one match → null (no pin)
    expect(
      pickSingleQuantFile(
        ["m-Q4_K_M-00001-of-00002.gguf", "m-Q4_K_M-00002-of-00002.gguf"],
        "Q4_K_M",
      ),
    ).toBeNull();
    expect(pickSingleQuantFile(["only-Q8_0.gguf"], "Q4_K_M")).toBeNull();
  });
});
