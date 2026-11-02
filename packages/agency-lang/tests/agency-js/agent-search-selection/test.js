import { writeFileSync } from "node:fs";
import { memoryHost } from "agency-lang/host-lib/memoryHost.js";
import { selectedSearch } from "./agent.js";

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

const results = {};
for (const [name, variables] of Object.entries(cases)) {
  const host = memoryHost({ variables });
  const { data } = await selectedSearch({ host });
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
