import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { memoryHost } from "agency-lang/host-lib/memoryHost.js";
import { context, readOptional, savedSession, __setLLMClient } from "./agent.js";

const scenario = process.argv[2];
const globalPath = join(homedir(), ".agency-agent", "AGENTS.md");
const files = {
  [globalPath]: "GLOBAL_PREF_V1",
  "/projects/first/AGENTS.md": "PROJECT_PREF",
  "/projects/first/CLAUDE.md": "CLAUDE_FALLBACK",
  "/projects/second/CLAUDE.md": "CLAUDE_FALLBACK",
};
const options = { cwd: "/projects/first", files, variables: {} };
if (scenario === "other-directory") {
  options.cwd = "/projects/second";
}
if (scenario === "override") {
  options.variables.AGENCY_AGENT_HOME = "/alternate";
  files["/alternate/AGENTS.md"] = "OVERRIDE_PREF";
}
if (scenario === "absent" || scenario === "singular") {
  delete files[globalPath];
}
if (scenario === "empty") {
  files[globalPath] = "  \n";
}
if (scenario === "singular") {
  files[join(homedir(), ".agency-agent", "AGENT.md")] = "SINGULAR_PREF";
}
if (scenario === "unreadable") {
  // The instruction-file path exists as a directory, so its read fails.
  files["/optional/AGENTS.md/child.txt"] = "not an instruction file";
}
if (scenario === "resume") {
  options.variables.RESUMED = "1";
  files[globalPath] = "GLOBAL_PREF_V2";
}
const host = memoryHost(options);

// A deterministic client keeps the test independent of model keys and services.
const usage = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, totalTokens: 2 };
const cost = { inputCost: 0, outputCost: 0, totalCost: 0, currency: "USD" };
__setLLMClient({
  async text() {
    return {
      success: true,
      value: { output: "ok", toolCalls: [], model: "test", usage, cost },
    };
  },
  async *textStream(config) {
    const result = await this.text(config);
    yield { type: "done", result: result.value };
  },
  async embed() {
    return { success: false, error: "Embedding is not used in this test" };
  },
});

let result;
if (scenario === "unreadable") {
  const loaded = await readOptional({ dir: "/optional" }, { host });
  result = {
    content: loaded.data,
    warned: host.state.output.join("\n").includes("AGENTS.md"),
  };
} else if (scenario === "start") {
  const started = await savedSession({ saved: null }, { host });
  const saved = JSON.stringify(started.data.saved);
  writeFileSync("test-output/checkpoint.json", saved);
  result = { checkpointHasNoStaleInstructions: !saved.includes("GLOBAL_PREF_V1") };
} else if (scenario === "resume") {
  const saved = JSON.parse(readFileSync("test-output/checkpoint.json", "utf8"));
  result = (await savedSession({ saved }, { host })).data;
} else {
  result = (await context({ host })).data;
}
process.stdout.write(JSON.stringify(result));
