/**
 * A docstring describes its parameters with `@param name - text` entries.
 * An entry starts at a line that begins with `@param <name>`, takes the
 * non-blank lines after it, and ends at the next `@param` line or at a
 * blank line, which goes with the entry. The dash after the name is
 * optional. Fenced Markdown examples stay in their containing entry or
 * prose; their blank lines and `@param` lines do not start or end entries.
 * Every reader uses `docSections` to find the same entry boundaries.
 */

const PARAM_LINE = /^\s*@param\s+(\w+)/;

/** One `@param` entry: the parameter's name and the text after it. */
export type ParamDoc = { name: string; text: string };

/** One `@param` entry with its lines, or one line outside any entry. */
type DocSection = { param: string | null; lines: string[] };

function docSections(description: string): DocSection[] {
  const sections: DocSection[] = [];
  let entry: DocSection | null = null;
  let fence = "";
  for (const line of description.split("\n")) {
    const trimmed = line.trim();
    const marker = trimmed.match(/^(`{3,}|~{3,})/)?.[0] ?? "";
    const opensFence = marker && (marker[0] !== "`" || !trimmed.slice(marker.length).includes("`"));
    if (fence || opensFence) {
      if (entry !== null) {
        entry.lines.push(line);
      } else {
        sections.push({ param: null, lines: [line] });
      }
      if (!fence) {
        fence = marker;
      } else if (trimmed === marker && marker[0] === fence[0] && marker.length >= fence.length) {
        fence = "";
      }
      continue;
    }
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

/**
 * Take the `@param` entries of `names` out of `description`: the text
 * without them, and each entry's text by name. The compiler puts that text
 * on the argument in a tool's schema. An entry `mayLift` refuses stays in
 * the description, and so does a second entry for a name already taken.
 * `params` has no prototype, so a parameter named `constructor` is found
 * only when it has an entry.
 */
export function liftParamDocs(
  description: string,
  names: string[],
  mayLift: (entry: string) => boolean = () => true,
): { description: string; params: Record<string, string> } {
  const params: Record<string, string> = Object.create(null);
  const kept = docSections(description).filter((section) => {
    const name = section.param;
    if (name === null || !names.includes(name) || name in params) return true;
    if (!mayLift(section.lines.join("\n"))) return true;
    params[name] = entryText(section.lines);
    return false;
  });
  return { description: joinSections(kept), params };
}

/** `description` with every `@param` entry removed, whatever its name. */
export function withoutParamDocs(description: string): string {
  return joinSections(docSections(description).filter((section) => section.param === null));
}
