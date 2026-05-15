import { z } from "zod";
import type * as smoltalk from "smoltalk";
import extractionTemplate from "../../templates/prompts/memory/extraction.js";
import { MemoryGraph } from "./graph.js";

// Zod schema for the structured output the LLM returns. We `safeParse`
// rather than throwing so a malformed response degrades to a no-op
// rather than killing the LLM call.
export const ExtractionResultSchema = z.object({
  entities: z.array(
    z.object({
      name: z.string(),
      type: z.string(),
      observations: z.array(z.string()),
    }),
  ),
  relations: z.array(
    z.object({
      from: z.string(), // entity name
      to: z.string(), // entity name
      type: z.string(),
    }),
  ),
  expirations: z.array(
    z.object({
      entityName: z.string(),
      observationContent: z.string(),
    }),
  ),
});

export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;

/**
 * Validate that an LLM extraction response has the shape we expect.
 * Returns null on JSON-parse failure or schema mismatch so the caller
 * can safely skip rather than throw.
 */
export function parseExtractionResult(text: string): ExtractionResult | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const result = ExtractionResultSchema.safeParse(raw);
  if (!result.success) {
    console.warn(
      `[memory] extraction parse failed: ${result.error.message}`,
    );
    return null;
  }
  return result.data;
}

export function buildExtractionPrompt(
  messages: smoltalk.Message[],
  graph: MemoryGraph
): string {
  const existingEntities = graph.getEntities();
  const entityContext =
    existingEntities.length > 0
      ? `\n\nExisting entities in the knowledge graph (merge with these, do not duplicate):\n${graph.toCompactIndex()}`
      : "";

  const conversationText = messages
    .map(
      (m) =>
        `${m.role}: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`
    )
    .join("\n");

  return extractionTemplate({ entityContext, conversationText });
}

export type ApplyExtractionOutcome = {
  newObservationIds: string[];
  expiredObservationIds: string[];
};

export function applyExtractionResult(
  graph: MemoryGraph,
  result: ExtractionResult,
  source: string
): ApplyExtractionOutcome {
  const newObservationIds: string[] = [];
  const expiredObservationIds: string[] = [];

  // Apply expirations first. Per resolved decision #7, extraction
  // expirations use exact-equality matching (case-insensitive).
  for (const exp of result.expirations) {
    const entity = graph.findEntityByName(exp.entityName);
    if (!entity) continue;
    const obs = entity.observations.find(
      (o) =>
        o.validTo === null &&
        o.content.toLowerCase() === exp.observationContent.toLowerCase()
    );
    if (obs) {
      graph.expireObservation(obs.id);
      expiredObservationIds.push(obs.id);
    }
  }

  // Add/merge entities and observations
  for (const extracted of result.entities) {
    let entity = graph.findEntityByName(extracted.name);
    if (!entity) {
      entity = graph.addEntity(extracted.name, extracted.type, source);
    }
    for (const obsContent of extracted.observations) {
      const obs = graph.addObservation(entity.id, obsContent);
      newObservationIds.push(obs.id);
    }
  }

  // Add relations (by entity name)
  for (const rel of result.relations) {
    const fromEntity = graph.findEntityByName(rel.from);
    const toEntity = graph.findEntityByName(rel.to);
    if (fromEntity && toEntity) {
      graph.addRelation(fromEntity.id, toEntity.id, rel.type, source);
    }
  }

  return { newObservationIds, expiredObservationIds };
}
