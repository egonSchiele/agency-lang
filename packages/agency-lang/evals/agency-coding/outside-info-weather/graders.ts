import { formatted } from "../lib/formatted.js";
import { outsideInfoJudge } from "../lib/outsideInfoJudge.js";

export default [
  formatted(),
  outsideInfoJudge({
    signature: 'forecast(city: string, units: string = "celsius")',
    needs: "today's weather forecast for a city the caller names",
    inputs: ["city", "units"],
    reference: `import { today } from "std::date"

type Forecast = {
  high: number;
  low: number;
  conditions: string
}

export def forecast(city: string, units: string = "celsius"): Forecast {
  """
  Today's weather forecast for a city.
  @param city - the city, with a country or state when the name is ambiguous
  @param units - "celsius" or "fahrenheit"
  """
  const result: Forecast = llm(
    """
    Today is \${today()}. Search the web for today's weather forecast for \${city}.
    Return the high and the low in degrees \${units}, and the conditions in a few words.
    Use only what the search results say.
    """,
    hostedTools: ["web_search"],
  )
  return result
}
`,
  }),
];
