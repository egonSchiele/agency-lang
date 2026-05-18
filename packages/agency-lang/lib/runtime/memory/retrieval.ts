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

function tokenRegex(s: string): RegExp {
  return new RegExp(`\\b${escapeRegex(s)}\\b`);
}

// Note on plural / inflection handling: type labels are stored
// verbatim as the LLM emitted them, so a query for "person" won't
// match an entity typed "persons" and vice versa. Adding a tiny
// inflection step (e.g. trailing-`s` strip) would cover ~80% of the
// gap; tracked as future work to keep this PR scoped.
export function structuredLookup(
  graph: MemoryGraph,
  query: string,
  options?: LookupOptions
): Entity[] {
  const lower = query.toLowerCase().trim();
  if (!lower) return [];
  const entities = graph.getEntities();

  // Loop-invariant: the query regex is the same for every entity and
  // every observation. Build it once before the filter.
  const queryRe = tokenRegex(lower);

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
      // The name regex is per-entity (not loop-invariant), but is
      // still built once per entity rather than once per observation.
      const nameRe = tokenRegex(nameLower);
      if (queryRe.test(nameLower) || nameRe.test(lower)) {
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
        // The content regex is per-observation and unavoidable —
        // each observation is a different needle when checking
        // "does query mention this observation". The query side uses
        // the loop-invariant `queryRe`.
        return queryRe.test(c) || tokenRegex(c).test(lower);
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
