// The graders for the Thom Yorke question. A module rather than a
// graders.json so the test can share `citationsResolve` with the two
// older tests. The checklist and band graders are graders.json specs,
// built by the same code; only the no-repeat grader is written here,
// because a graders.json count narrows to one tool and this one covers
// every retrieval tool.
import { binary, buildGraders, grader, type GraderSpec } from "agency-lang/eval";

import { citationsResolve } from "../lib/researchGraders.js";

const SOURCES = "sources.md";

/** Cost and speed count for little beside the answer's quality: each band
 *  weighs a tenth of the facts checklist. */
const BAND_WEIGHT = 0.1;
const NO_REPEAT_WEIGHT = 0.3;

const specs: GraderSpec[] = [
  {
    kind: "checklist",
    name: "answered",
    mustPass: true,
    points: [
      'The answer has body text: it is not empty and not only a failure line such as "research agent failed". A closing note that the time or cost budget ran out does not fail this point when there is an answer above it.',
      "The answer says things about Thom Yorke; it is not only a statement that nothing could be found.",
    ],
  },
  {
    kind: "checklist",
    name: "facts",
    context: SOURCES,
    points: [
      "Says that his university degree at Exeter was in English (literature) and art, and that it was not a music degree.",
      "Says he got a guitar as a child, inspired by Queen's Brian May.",
      "Mentions that he took classical guitar lessons at Abingdon School, or otherwise describes music lessons at school as part of how he learned.",
      "Says that Yorke has said he cannot read music (optionally noting his school music director called that a slight exaggeration).",
      "Names the Abingdon School music and art departments as where he found a home, or quotes his line that the music school and the art school were his sanctuary.",
      "Describes his turn to electronic music around Kid A, naming Warp Records artists such as Autechre or Aphex Twin as the influence, or his later laptop-made solo work such as The Eraser.",
      "Contrasts him with Jonny Greenwood as the band member with the formal musical knowledge, or otherwise says the arrangement and theory side comes from his bandmates.",
      "Answers the strengths question directly: says where his strengths lie (for example voice and melody, or beats and electronics) rather than skipping it.",
    ],
  },
  {
    kind: "checklist",
    name: "sourcing",
    context: SOURCES,
    points: [
      'Cites at least two of the long interviews listed under "Long-form sources" in the context, by URL.',
      "Cites at least one source that is not Wikipedia.",
      "Quotes Yorke's own words at least twice, in quotation marks, attributed to a cited source.",
      "Every factual claim about his education or training is tied to a cited source; none is stated from memory with no citation.",
    ],
  },
  // Full marks at a focused run. Zero at forty calls, and at the
  // researcher's caps of six minutes and three dollars.
  {
    kind: "number",
    name: "llm-calls",
    measure: "llmCalls",
    full: 8,
    zero: 40,
    weight: BAND_WEIGHT,
  },
  {
    kind: "number",
    name: "wall-seconds",
    measure: "agentSeconds",
    full: 90,
    zero: 360,
    weight: BAND_WEIGHT,
  },
  {
    kind: "number",
    name: "cost-usd",
    measure: "costUsd",
    full: 0.25,
    zero: 3,
    weight: BAND_WEIGHT,
  },
];

/** The tools that retrieve something: the three fetches, the three
 *  Wikipedia lookups, and the two web searches. Communication tools and
 *  `saveDraft` are left out, since a draft that grows at the end looks the
 *  same in the record's 200-character argument preview. */
const RETRIEVAL_TOOLS = [
  "fetch",
  "fetchMarkdown",
  "fetchJSON",
  "wikipedia_article",
  "wikipedia_summary",
  "wikipedia_search",
  "web_search_tavily",
  "web_search_brave",
];

/** A retrieval tool called twice with the same arguments, anywhere in the
 *  run (the grounding reviewer's calls included), fails. The comparison is
 *  the record's argument preview, so two URLs that differ only after its
 *  200th character count as one call, and one URL spelled two ways (with
 *  and without a trailing slash, through `fetch` and `fetchMarkdown`)
 *  counts as two. */
const noRepeatedRetrieval = grader(
  ({ record }) => {
    const calls = record.events.flatMap((event) =>
      event.kind === "tool_start" && RETRIEVAL_TOOLS.includes(event.tool)
        ? [{ tool: event.tool, args: event.argsPreview }]
        : [],
    );
    const repeats = calls.filter((call, index) =>
      calls
        .slice(0, index)
        .some((earlier) => earlier.tool === call.tool && earlier.args === call.args),
    );
    const lines = repeats.map((call) => `${call.tool}(${call.args})`).join("\n");
    return binary(
      repeats.length === 0,
      `${repeats.length} repeated retrieval calls${lines ? `\n${lines}` : ""}`,
    );
  },
  { name: "no-repeated-retrieval", weight: NO_REPEAT_WEIGHT },
);

export default [...buildGraders(specs), noRepeatedRetrieval, citationsResolve()];
