import { main, __setLLMClient } from "./agent.js";
import { readFileSync, writeFileSync } from "node:fs";
import { ToolCall } from "smoltalk";

const requests = [];
const client = {
  async text(config) {
    requests.push({
      tools: config.tools.map((tool) => ({ name: tool.name, schema: tool.schema.toJSONSchema() })),
      messages: config.messages.map((message) => message.toJSON()),
    });
    return {
      success: true,
      value: {
        output: requests.length < 3 ? null : "restored answer",
        toolCalls:
          requests.length < 3
            ? [
                new ToolCall(
                  `restored-call-${requests.length}`,
                  requests.length === 1 ? "session_seriesInfo" : "session_seriesLabel",
                  { id: "UNRATE" },
                ),
              ]
            : [],
        model: "test",
        usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, totalTokens: 2 },
        cost: { inputCost: 0, outputCost: 0, totalCost: 0, currency: "USD" },
      },
    };
  },
  async *textStream(config) {
    const result = await this.text(config);
    yield { type: "done", result: result.value };
  },
  async embed() {
    return { success: false, error: "not implemented" };
  },
};
__setLLMClient(client);
const result = await main();
writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      data: result.data,
      records: JSON.parse(readFileSync("test-output/record-check.json", "utf8")),
      schemaRestored: requests[0]?.tools.every(
        (tool) => tool.schema.properties.seriesId.type === "string",
      ),
      aliasCallUsesPreparedSource:
        JSON.stringify(requests[2]?.messages).includes("original:UNRATE") &&
        JSON.stringify(requests[2]?.messages).includes("label:UNRATE"),
    },
    null,
    2,
  ),
);
