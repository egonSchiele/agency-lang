import { describe, expect, it } from "vitest";
import { MLX_VLM_RULES, vlmServeArgs } from "./vlmChat.js";
import { applyRequestRules } from "./requestRules.js";
import { mlxThinkingAttributes, mlxReplyLimitAttributes } from "../runtime/localDefaults.js";

const prepare = (body: Record<string, unknown>, path = "/v1/chat/completions", method = "POST") =>
  applyRequestRules(MLX_VLM_RULES, { method, path, body });

describe("vision chat", () => {
  it("binds to loopback and generates one request at a time", () => {
    expect(vlmServeArgs("/models/qwen", 9001, 600)).toEqual([
      "-m",
      "mlx_vlm.server",
      "--model",
      "/models/qwen",
      "--host",
      "127.0.0.1",
      "--port",
      "9001",
      "--max-tokens",
      "600",
      "--max-num-seqs",
      "1",
      "--log-level",
      "CRITICAL",
    ]);
  });
  it.each(["hi", [{ type: "image_url", image_url: { url: "data:image/png;base64,YQ==" } }]])(
    "accepts client content %j",
    (content) => {
      const body = { messages: [{ role: "user", content }] };
      expect(prepare(body)).toEqual({ body });
    },
  );
  it.each(["http://example.org/a.png", "/tmp/a.png", "file:///tmp/a.png"])(
    "refuses image source %s",
    (url) => {
      expect(
        prepare({ messages: [{ content: [{ type: "image_url", image_url: { url } }] }] }),
      ).toMatchObject({ refusal: { status: 400 } });
    },
  );
  it.each(["input_image", "input_audio", "constructor", "__proto__"])("refuses part %s", (type) => {
    expect(prepare({ messages: [{ content: [{ type, file_id: "/tmp/private" }] }] })).toMatchObject(
      { refusal: { status: 400 } },
    );
  });
  it.each([
    ["POST", "/unload"],
    ["PATCH", "/v1/settings"],
    ["POST", "/v1/images/generations"],
  ])("refuses %s %s", (method, path) => {
    expect(prepare({}, path, method)).toMatchObject({ refusal: { status: 404 } });
  });
  it("forwards schemas and tools", () => {
    const body = { response_format: { type: "json_schema" }, tools: [{ type: "function" }] };
    expect(prepare(body)).toEqual({ body });
  });
  it.each([true, false])("translates the client's thinking setting %s", (enabled) => {
    expect(prepare(mlxThinkingAttributes({ enabled }, undefined))).toEqual({
      body: { enable_thinking: enabled },
    });
  });
  it("translates client budget and effort", () => {
    expect(prepare(mlxThinkingAttributes({ enabled: true, budgetTokens: 40 }, "low"))).toEqual({
      body: { enable_thinking: true, thinking_budget: 40, reasoning_effort: "low" },
    });
  });
  it("refuses every client reply limit", () => {
    const fields = mlxReplyLimitAttributes({ hedgeLimit: 2, repeatLimit: 2, limitAnswers: true });
    for (const [key, value] of Object.entries(fields)) {
      expect(prepare({ [key]: value })).toMatchObject({ refusal: { status: 400 } });
    }
  });
});
