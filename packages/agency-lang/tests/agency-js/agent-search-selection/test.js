import { writeFileSync } from "node:fs";
import { memoryHost } from "agency-lang/host-lib/memoryHost.js";
import {
  selectedSearch,
  selectedSearchBraveMode,
  selectedSearchOffMode,
  selectedSearchTavilyMode,
} from "./agent.js";

const braveKey = "fixture-brave-key";
const tavilyKey = "fixture-tavily-key";
const cases = {
  both: { BRAVE_API_KEY: braveKey, TAVILY_API_KEY: tavilyKey },
  braveOnly: { BRAVE_API_KEY: braveKey },
  tavilyOnly: { TAVILY_API_KEY: tavilyKey },
  neither: {},
  emptyKeys: { BRAVE_API_KEY: "", TAVILY_API_KEY: "" },
  emptyBrave: { BRAVE_API_KEY: "", TAVILY_API_KEY: tavilyKey },
  emptyTavily: { BRAVE_API_KEY: braveKey, TAVILY_API_KEY: "" },
};
const envKeys = {
  web_search_brave: "BRAVE_API_KEY",
  web_search_tavily: "TAVILY_API_KEY",
};

// A search mode names one provider or none. Brave wins in auto mode when
// both keys are set, so tavily mode with both keys is the case that tells
// the two apart, and a named provider with no key offers nothing.
const modeCases = {
  tavilyModeBothKeys: { node: selectedSearchTavilyMode, variables: cases.both },
  braveModeTavilyOnly: { node: selectedSearchBraveMode, variables: cases.tavilyOnly },
  offModeBothKeys: { node: selectedSearchOffMode, variables: cases.both },
};
const runs = [
  ...Object.entries(cases).map(([name, variables]) => ({ name, node: selectedSearch, variables })),
  ...Object.entries(modeCases).map(([name, modeCase]) => ({ name, ...modeCase })),
];

const results = {};
for (const { name, node, variables } of runs) {
  const host = memoryHost({ variables });
  const { data } = await node({ host });
  results[name] = {
    providerNames: data.providerNames,
    tools: data.tools.map((tool) => {
      const keyParam = tool.params.find((param) => param.name === "apiKey");
      const schema = tool.toolDefinition.schema.toJSONSchema();
      return {
        name: tool.name,
        keyBound:
          keyParam?.isBound === true && keyParam.boundValue === variables[envKeys[tool.name]],
        keyHidden: !Object.hasOwn(schema.properties, "apiKey"),
      };
    }),
  };
}

writeFileSync("__result.json", JSON.stringify(results, null, 2));
