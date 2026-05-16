import type { Entity } from "./types.js";
import { MemoryGraph } from "./graph.js";

type LookupOptions = {
  source?: string;
};

// Names this short are nearly always articles, pronouns, or filler
// (e.g. "I", "me", "an") — matching them word-for-word in arbitrary
// queries causes runaway false positives. Real proper nouns and
// type names are almost always longer than this.
const MIN_NAME_LENGTH = 3;

// Common English stop words that occasionally show up as entity
// names in noisy LLM extraction. Skipping them is cheaper than
// asking the LLM to disambiguate downstream.
const STOP_WORDS = new Set([
  "the", "and", "you", "for", "not", "but", "are", "was", "were",
  "with", "this", "that", "have", "has", "had", "from", "they",
  "their", "them", "there", "here", "what", "when", "where",
  "which", "who", "why", "how", "your", "our", "its",
]);

function isMeaningfulName(lowerName: string): boolean {
  if (lowerName.length < MIN_NAME_LENGTH) return false;
  return !STOP_WORDS.has(lowerName);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Word-boundary substring test. Treats `needle` as a token sequence
// (so "Bob" finds "Bob" in "tell me about Bob" but not in "Bobby").
// Both sides are assumed already lowercased by the caller.
function containsToken(haystack: string, needle: string): boolean {
  if (!needle) return false;
  const re = new RegExp(`\\b${escapeRegex(needle)}\\b`);
  return re.test(haystack);
}

export function structuredLookup(
  graph: MemoryGraph,
  query: string,
  options?: LookupOptions
): Entity[] {
  const lower = query.toLowerCase().trim();
  if (!lower) return [];
  const entities = graph.getEntities();

  const matches = entities.filter((entity) => {
    if (options?.source && entity.source !== options.source) return false;

    // Name match — bidirectional with word boundaries.
    //   - "query mentions name" handles natural-language queries:
    //     `recall("Tell me about Maggie")` finds entity "Maggie".
    //   - "name contains query" handles short keyword queries:
    //     `recall("maggie")` still finds entity "Maggie" (and also
    //     finds entity "Margaret Maggie Smith" if it exists).
    //
    // Skip names that are too short or are stop words to avoid
    // matching everything in sight.
    const nameLower = entity.name.toLowerCase();
    if (isMeaningfulName(nameLower)) {
      if (
        containsToken(lower, nameLower) ||
        containsToken(nameLower, lower)
      ) {
        return true;
      }
    }

    // Type match — exact, case-insensitive. Types are short
    // categorical labels ("person", "place"), so word-boundary
    // matching against arbitrary queries is too noisy; we only
    // accept the bare label as a query.
    if (entity.type.toLowerCase() === lower) return true;

    // Observation content match — same bidirectional pattern.
    // No length/stopword filter on observations because we want
    // even short queries to find them ("weave" → "loves to weave").
    const currentObs = graph.getCurrentObservations(entity.id);
    if (
      currentObs.some((o) => {
        const c = o.content.toLowerCase();
        return containsToken(c, lower) || containsToken(lower, c);
      })
    ) {
      return true;
    }

    return false;
  });

  return matches;
}

export function formatRetrievalResults(
  graph: MemoryGraph,
  entities: Entity[]
): string {
  if (entities.length === 0) return "";

  const lines: string[] = [];
  for (const entity of entities) {
    const current = graph.getCurrentObservations(entity.id);
    lines.push(`${entity.name} (${entity.type}):`);
    for (const obs of current) {
      lines.push(`  - ${obs.content}`);
    }
    const relsFrom = graph.getRelationsFrom(entity.id);
    for (const rel of relsFrom) {
      const target = graph.getEntity(rel.to);
      lines.push(`  - ${rel.type} → ${target?.name ?? rel.to}`);
    }
    const relsTo = graph.getRelationsTo(entity.id);
    for (const rel of relsTo) {
      const source = graph.getEntity(rel.from);
      lines.push(`  - ${source?.name ?? rel.from} ${rel.type} → ${entity.name}`);
    }
  }
  return lines.join("\n");
}
