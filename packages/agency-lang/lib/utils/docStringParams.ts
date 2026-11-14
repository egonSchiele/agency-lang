import { PromptSegment } from "@/types/literals.js";

const PARAM_LINE = /^\s*@param\s+([A-Za-z_]\w*)\s+-\s+(.*)$/;

type Lifted = { segments: PromptSegment[]; params: Record<string, string> };

/**
 * Take the `@param name - text` entries for `names` out of a docstring.
 * The compiler puts each one on that argument in the tool's schema, so the
 * tool description no longer repeats it.
 *
 * An entry runs from its `@param` line to the next blank line or the next
 * line that starts with `@`. An entry that touches an interpolation stays
 * in the description: its text is not known until the program runs.
 */
export function liftParamDocs(segments: PromptSegment[], names: string[]): Lifted {
  const params: Record<string, string> = {};
  const result = segments.map((segment, index) => {
    if (segment.type !== "text") {
      return segment;
    }
    const lines = segment.value.split("\n");
    // The first line of a segment that follows an interpolation, and the
    // last line of one that precedes an interpolation, are parts of lines.
    const firstWhole = index === 0 ? 0 : 1;
    const lastWhole = index === segments.length - 1 ? lines.length - 1 : lines.length - 2;
    const kept: string[] = [];
    let i = 0;
    while (i < lines.length) {
      const match = i >= firstWhole && i <= lastWhole ? PARAM_LINE.exec(lines[i]) : null;
      const end = match ? entryEnd(lines, i) : i;
      if (!match || !names.includes(match[1]) || end > lastWhole || match[1] in params) {
        kept.push(lines[i]);
        i++;
        continue;
      }
      const rest = lines.slice(i + 1, end + 1).map((line) => line.trim());
      params[match[1]] = [match[2].trim(), ...rest].join(" ");
      i = end + 1;
    }
    return { ...segment, value: kept.join("\n") };
  });
  return { segments: result, params };
}

/** The index of the last line of the entry that starts at `start`. */
function entryEnd(lines: string[], start: number): number {
  let end = start;
  while (end + 1 < lines.length) {
    const next = lines[end + 1].trim();
    if (next === "" || next.startsWith("@")) {
      break;
    }
    end++;
  }
  return end;
}
