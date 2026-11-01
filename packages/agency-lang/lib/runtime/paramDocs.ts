/**
 * A docstring describes its parameters with `@param name - text` entries.
 * An entry starts at a line that begins with `@param <name>`, takes the
 * non-blank lines after it, and ends at the next `@param` line or at a
 * blank line, which goes with the entry. The dash after the name is
 * optional. Every reader of these entries goes through `docSections`, so
 * they all agree on where an entry ends.
 */

const PARAM_LINE = /^\s*@param\s+(\w+)/;

/** One `@param` entry: the parameter's name and the text after it. */
export type ParamDoc = { name: string; text: string };

/** One `@param` entry with its lines, or one line outside any entry. */
type DocSection = { param: string | null; lines: string[] };

function docSections(description: string): DocSection[] {
  const sections: DocSection[] = [];
  let entry: DocSection | null = null;
  for (const line of description.split("\n")) {
    const match = line.match(PARAM_LINE);
    if (match) {
      entry = { param: match[1], lines: [line] };
      sections.push(entry);
    } else if (entry !== null) {
      entry.lines.push(line);
      if (line.trim() === "") {
        entry = null;
      }
    } else {
      sections.push({ param: null, lines: [line] });
    }
  }
  return sections;
}

function joinSections(sections: DocSection[]): string {
  return sections.flatMap((section) => section.lines).join("\n");
}

/** The entry's first line after the name and an optional dash, then each
 *  line after it, each trimmed and joined by a space. */
function entryText(lines: string[]): string {
  const [first, ...rest] = lines;
  const head = first.replace(PARAM_LINE, "").trim().replace(/^-\s*/, "");
  return [head, ...rest.map((line) => line.trim())].join(" ").trim();
}

/** Every `@param` entry in `description`, in order. */
export function paramDocs(description: string): ParamDoc[] {
  return docSections(description).flatMap((section) =>
    section.param === null ? [] : [{ name: section.param, text: entryText(section.lines) }],
  );
}

/** `description` without the `@param` entries of `boundParamNames`. */
export function stripBoundParams(description: string, boundParamNames: string[]): string {
  const kept = docSections(description).filter(
    (section) => section.param === null || !boundParamNames.includes(section.param),
  );
  return joinSections(kept);
}

/** `description` with every `@param` entry removed, whatever its name. */
export function withoutParamDocs(description: string): string {
  return joinSections(docSections(description).filter((section) => section.param === null));
}
