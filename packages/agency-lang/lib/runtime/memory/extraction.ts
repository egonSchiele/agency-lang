import type { MemoryMessage } from "./types.js";
import { MemoryGraph } from "./graph.js";

// The structured output type the LLM returns
export type ExtractionResult = {
  entities: Array<{
    name: string;
    type: string;
    observations: string[];
  }>;
  relations: Array<{
    from: string; // entity name
    to: string; // entity name
    type: string;
  }>;
  expirations: Array<{
    entityName: string;
    observationContent: string;
  }>;
};

export function buildExtractionPrompt(
  messages: MemoryMessage[],
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

  return `Extract structured facts from the following conversation.${entityContext}

Conversation:
${conversationText}

Return a JSON object with:
- "entities": array of { name, type, observations: string[] }. If an entity already exists above, use the EXACT same name to merge. Only include new observations.
- "relations": array of { from, to, type } where from/to are entity names. Only include new relations.
- "expirations": array of { entityName, observationContent } for any existing observations that are now contradicted by new information.

Only extract facts that are clearly stated or strongly implied. Do not speculate.`;
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
