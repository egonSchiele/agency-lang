import retrievalTemplate from "../../templates/prompts/memory/retrieval.js";
import type { Entity } from "./types.js";
import { MemoryGraph } from "./graph.js";

type LookupOptions = {
  source?: string;
};

export function structuredLookup(
  graph: MemoryGraph,
  query: string,
  options?: LookupOptions
): Entity[] {
  const lower = query.toLowerCase();
  const entities = graph.getEntities();

  const matches = entities.filter((entity) => {
    if (options?.source && entity.source !== options.source) return false;

    // Match by name (substring)
    if (entity.name.toLowerCase().includes(lower)) return true;

    // Match by type (exact, case-insensitive)
    if (entity.type.toLowerCase() === lower) return true;

    // Match by current observation content (substring)
    const currentObs = graph.getCurrentObservations(entity.id);
    if (currentObs.some((o) => o.content.toLowerCase().includes(lower))) {
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

export function buildRetrievalPrompt(
  query: string,
  graph: MemoryGraph
): string {
  return retrievalTemplate({ graphIndex: graph.toCompactIndex(), query });
}
