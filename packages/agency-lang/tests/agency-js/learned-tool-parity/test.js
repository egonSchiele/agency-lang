import { main, __setLLMClient } from "./agent.js";
import { ToolCall } from "smoltalk";
import { writeFileSync } from "node:fs";

const usage = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, totalTokens: 2 };
const cost = { inputCost: 0, outputCost: 0, totalCost: 0, currency: "USD" };

async function conversation(learned, script) {
  const requests = [];
  const client = {
    async text(config) {
      requests.push({
        tools: config.tools.map((tool) => ({
          name: tool.name,
          schema: tool.schema.toJSONSchema(),
        })),
        messages: config.messages.map((message) => message.toJSON()),
      });
      const next = script[requests.length - 1];
      return {
        success: true,
        value: {
          output: next ? null : "done",
          toolCalls: next ? [new ToolCall(`call-${requests.length}`, next.name, next.args)] : [],
          model: "test",
          usage,
          cost,
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
  __setLLMClient(client);
  const result = await main(learned);
  if (result.data !== "done")
    throw new Error(`Conversation did not finish: ${JSON.stringify(result.data)}`);
  return {
    requests,
    replies: requests
      .at(-1)
      .messages.filter((message) => message.role === "tool")
      .map((message) => message.content),
  };
}

const probe = (args) => ({ name: "probe", args });
const other = (args) => ({ name: "other", args });
const scripts = {
  arguments: [
    probe({ q: "alias", limit: null, items: [1, 2] }),
    probe({ query: "unknown", unexpected: true }),
    probe({}),
    probe({ query: "canonical", q: "alias" }),
    probe({ query: "bad-variadic", items: 3 }),
    probe({ query: "after-errors", limit: 4, items: [] }),
  ],
  repeats: [
    probe({ query: "same" }),
    probe({ q: "same" }),
    probe({ query: "same" }),
    probe({ q: "same" }),
    other({ query: "same" }),
  ],
  removal: [
    ...Array.from({ length: 5 }, (_, i) => probe({ query: `invalid-${i}`, unexpected: true })),
    probe({ query: "removed" }),
    other({ q: "still-available" }),
  ],
};

const results = {};
for (const [name, script] of Object.entries(scripts)) {
  const ordinary = await conversation(false, script);
  const learned = await conversation(true, script);
  results[name] = {
    sameSchemas:
      JSON.stringify(ordinary.requests[0].tools) === JSON.stringify(learned.requests[0].tools),
    sameReplies: JSON.stringify(ordinary.replies) === JSON.stringify(learned.replies),
  };
  if (name === "arguments") {
    results[name].aliasAndNullDefault = learned.replies[0];
    results[name].unknownArgument = learned.replies[1].includes(
      "Unknown named argument 'unexpected'",
    );
    results[name].missingArgument = learned.replies[2].includes(
      "Missing required argument 'query'",
    );
    results[name].aliasConflict =
      learned.replies[3].includes("query") && learned.replies[3].includes("q");
    results[name].variadicMustBeArray = learned.replies[4].includes("must be bound to an array");
    results[name].stillCallable = learned.replies[5];
  } else if (name === "repeats") {
    results[name].aliasRepeatRefused = learned.replies[3].includes("It was not run");
    results[name].otherCallRan = learned.replies[4].query === "same";
  } else {
    results[name].removedAfterFiveErrors = learned.replies[4].includes("failed too many times");
    results[name].onlyFailedToolRemoved = learned.requests[5].tools.map((tool) => tool.name);
    results[name].otherCallRan = learned.replies[6].query === "still-available";
  }
}
writeFileSync("__result.json", JSON.stringify(results, null, 2));
