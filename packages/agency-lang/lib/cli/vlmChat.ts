import { anyPart, dataImagePart, type RequestRules } from "./requestRules.js";

/** Request rules depend on this release's fields and routes. Check them before moving the pin. */
export const MLX_VLM_VERSION = "0.7.0";
const VLM_CONCURRENT_REQUESTS = 1;

export function vlmServeArgs(modelDir: string, internalPort: number, maxTokens: number): string[] {
  return [
    "-m",
    "mlx_vlm.server",
    "--model",
    modelDir,
    "--host",
    "127.0.0.1",
    "--port",
    String(internalPort),
    "--max-tokens",
    String(maxTokens),
    "--max-num-seqs",
    String(VLM_CONCURRENT_REQUESTS),
    // Upstream error logs include the full data URI for an invalid image.
    // Agency logs request status itself without printing image payloads.
    "--log-level",
    "CRITICAL",
  ];
}

export function imageChatExample(name: string): string[] {
  return [
    "",
    "  In Agency code:",
    '    import { image } from "std::thread"',
    `    llm(["What is in this picture?", image("photo.png")], { provider: "mlx", model: ${JSON.stringify(name)} })`,
  ];
}

export const MLX_VLM_RULES: RequestRules = {
  routes: [{ method: "POST", path: "/v1/chat/completions" }],
  parts: { text: anyPart, image_url: dataImagePart },
  moved: [
    { from: "chat_template_kwargs.enable_thinking", to: "enable_thinking" },
    { from: "chat_template_kwargs.reasoning_effort", to: "reasoning_effort" },
    { from: "reasoning_budget", to: "thinking_budget" },
  ],
  refused: ["chat_template_kwargs", "hedge_limit", "repeat_limit", "limit_answers"],
};
