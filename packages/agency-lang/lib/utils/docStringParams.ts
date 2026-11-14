import { PromptSegment } from "@/types/literals.js";
import { liftParamDocs } from "./paramDocs.js";

/** Stands for one `${...}` of a docstring while its text is searched for
 *  `@param` entries. A private-use character, so no docstring holds it. */
const HOLE = "";

type Lifted = { segments: PromptSegment[]; params: Record<string, string> };

/**
 * `liftParamDocs` for a docstring's segments. An entry that holds an
 * interpolation stays in the description: its text is not known until the
 * program runs.
 */
export function liftParamSegments(segments: PromptSegment[], names: string[]): Lifted {
  const holes = segments.filter((segment) => segment.type !== "text");
  const joined = segments.map((segment) => (segment.type === "text" ? segment.value : HOLE));
  const lifted = liftParamDocs(joined.join(""), names, (entry) => !entry.includes(HOLE));
  const texts = lifted.description.split(HOLE);
  const result: PromptSegment[] = [];
  texts.forEach((value, index) => {
    if (value !== "") {
      result.push({ type: "text", value });
    }
    if (index < holes.length) {
      result.push(holes[index]);
    }
  });
  return { segments: result, params: lifted.params };
}
