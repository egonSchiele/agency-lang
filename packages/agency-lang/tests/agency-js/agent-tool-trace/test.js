import { main, __setLLMClient } from "./agent.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { ToolCall } from "smoltalk";

const narration = "Checking the release notes and both search providers.";
const calls = [
  ["echo", { value: "first result" }],
  ["echo", { value: "second result" }],
  ["successful", {}],
  ["failedFixture", {}],
  ["read", { filename: "a.md", offset: 1, limit: 20 }],
  ["researchAgent", { userMsg: "Find the original model announcement" }],
  ["web_search_tavily", {}],
  ["web_search_tavily", { query: 'site.example.com "quoted phrase"' }],
  ["web_search_brave", { query: "another query" }],
];
const callRounds = [calls, []];
const hostedToolResults = [
  {
    tool: "web_search",
    provider: "openai-responses",
    queries: ['site.example.com "quoted phrase"', "another query"],
    sources: [{ title: "Hosted fixture source", url: "https://hosted.example/source" }],
  },
  { tool: "web_search", provider: "test-provider", queries: [] },
];

function makeClient() {
  let requests = 0;
  return {
    async text() {
      requests += 1;
      if (requests > callRounds.length) {
        throw new Error("Unexpected model request in tool trace fixture");
      }
      const first = requests === 1;
      return {
        success: true,
        value: {
          output: requests === callRounds.length ? "done" : narration,
          toolCalls: callRounds[requests - 1].map(
            ([name, args], index) => new ToolCall(`call-${requests}-${index}`, name, args),
          ),
          hostedToolResults: first ? hostedToolResults : [],
          model: "test",
          usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, totalTokens: 2 },
          cost: { inputCost: 0, outputCost: 0, totalCost: 0, currency: "USD" },
        },
      };
    },
    async *textStream(config) {
      const response = await this.text(config);
      yield { type: "done", result: response.value };
    },
    async embed() {
      throw new Error("Unexpected embedding request in tool trace fixture");
    },
  };
}

const modes = {
  interactive: { interactive: true, verbose: false, debug: false },
  quiet: { interactive: false, verbose: false, debug: false },
  verbose: { interactive: false, verbose: true, debug: false },
  debug: { interactive: false, verbose: false, debug: true },
};
const outputs = {};
const results = {};
for (const [name, mode] of Object.entries(modes)) {
  __setLLMClient(makeClient());
  const printed = [];
  const realLog = console.log;
  console.log = (...args) => printed.push(args.join(" "));
  try {
    const result = await main(mode.interactive, mode.verbose, mode.debug);
    results[name] = result.data;
  } finally {
    console.log = realLog;
  }
  outputs[name] = printed.join("\n").replace(/\x1b\[[\d;]*m/g, "");
}

function blockWith(output, heading) {
  return output.split("\n\n").find((block) => block.split("\n").includes(heading)) ?? "";
}

function detailed(output) {
  return {
    narrationOnce: output.split(narration).length === 2,
    twoHostedSearches:
      output.split("\n").filter((line) => line === "⌕ Web search  web_search").length === 2,
    hostedQueries: output.includes(
      '  │ openai-responses · 2 queries\n  │ · site.example.com "quoted phrase"\n  │ · another query',
    ),
    hostedSources: ["Hosted fixture source", "https://hosted.example/source"].every((value) =>
      blockWith(output, "⌕ Web search  web_search").includes(value),
    ),
    missingQueries: output.includes("  │ test-provider\n  │ Queries not reported"),
    ordinaryStart: output.includes('● Tool call  echo\n  │ value: "first result"'),
    independentReturns: ["first result", "second result"].every((value) =>
      output.includes(`✓ Tool finished  echo\n  │ ${value}\n`),
    ),
    unwrappedSuccess: output.includes("✓ Tool finished  successful\n  │ wrapped-ok"),
    unwrappedFailure: output.includes("✗ Tool failed  failedFixture\n  │ fixture failure"),
    failedToolNeverSucceeded: !output.includes("✓ Tool finished  failedFixture"),
    summaryLine: output.includes("✓ Read a.md lines 1–20"),
    noSummaryStart: !output.includes("● Tool call  read"),
    malformedSearchStaysCustom: output.includes(
      "⌕ Web search  web_search_tavily\n  │ Tavily\n  │ Queries not reported",
    ),
    clientSearches: [
      ["web_search_tavily", "Tavily"],
      ["web_search_brave", "Brave"],
    ].every(([toolName, provider]) =>
      output.includes(`⌕ Web search  ${toolName}\n  │ ${provider} · 1 query`),
    ),
    clientSources: [
      ["web_search_tavily", "Tavily", "tavily"],
      ["web_search_brave", "Brave", "brave"],
    ].every(([toolName, provider, domain]) => {
      const block = blockWith(output, `✓ Web search  ${toolName}`);
      return [
        provider,
        "1 source",
        `${provider} fixture source`,
        `https://${domain}.example/source`,
      ].every((value) => block.includes(value));
    }),
    noGenericSearch: !/Tool (call|returned|finished|failed)  web_search_/.test(output),
    oneResearchStart:
      output.split("→ Research  researchAgent\n  │ Find the original model announcement").length ===
      2,
    researchFinished: output.includes(
      "✓ Research finished  researchAgent\n  │ Research fixture result",
    ),
    noGenericResearch: !/Tool (call|returned|finished|failed)  researchAgent/.test(output),
    noLegacyResearch: !output.includes("→ researchAgent:"),
  };
}

mkdirSync("test-output", { recursive: true });
writeFileSync("test-output/trace.json", JSON.stringify(outputs, null, 2));
writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      results,
      interactive: detailed(outputs.interactive),
      quietHasNoTraces:
        !/Tool call|Tool returned|Tool finished|Tool failed|Web search|Searching web|→ Research|Research finished|→ researchAgent:|⏺/.test(
          outputs.quiet,
        ) && !outputs.quiet.includes(narration),
      interactiveNarrationOwnLine: outputs.interactive.split("\n").includes(narration),
      verbose: detailed(outputs.verbose),
      debug: detailed(outputs.debug),
      debugDiagnostics: outputs.debug.includes("💬 [test]"),
      interactiveHasNoDiagnostics: !outputs.interactive.includes("💬"),
    },
    null,
    2,
  ),
);
