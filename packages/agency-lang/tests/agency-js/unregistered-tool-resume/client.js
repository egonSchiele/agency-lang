import { ToolCall } from "smoltalk";

export function scriptedClient(stage, kind, captured) {
  let calls = 0;
  return {
    async text(config) {
      let output = null;
      let toolCalls;
      if (stage === "initial") {
        toolCalls = [new ToolCall("pause", "pauseTool", {})];
      } else if (calls === 0) {
        const tool = config.tools.find(tool => tool.name === "runtimeEcho");
        captured.schemaRestored = !!tool?.schema?.toJSONSchema().properties?.query;
        toolCalls = [new ToolCall("echo", "runtimeEcho", kind === "created" ? { q: "hello" } : {})];
      } else {
        const messages = config.messages.map(message => message.toJSON?.() ?? message);
        captured.reply = messages.findLast(message => message.role === "tool")?.content;
        output = "done";
        toolCalls = [];
      }
      calls++;
      return {
        success: true,
        value: {
          output,
          toolCalls,
          model: "test",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cachedInputTokens: 0 },
          cost: { inputCost: 0, outputCost: 0, totalCost: 0, currency: "USD" },
        },
      };
    },
    async *textStream(config) {
      const result = await this.text(config);
      yield { type: "done", result: result.value };
    },
    async embed() {
      throw new Error("This fixture does not use embeddings");
    },
  };
}
