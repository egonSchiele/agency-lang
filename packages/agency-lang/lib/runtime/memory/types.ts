// Core types for the memory layer.
import { z } from "zod";

export type Observation = {
  id: string;
  content: string;
  validFrom: string; // ISO 8601
  validTo: string | null; // null = currently active
};

export type Entity = {
  id: string;
  name: string;
  type: string;
  source: string;
  createdAt: string;
  observations: Observation[];
};

export type Relation = {
  id: string;
  from: string; // entity ID
  to: string; // entity ID
  type: string;
  source: string;
  validFrom: string;
  validTo: string | null;
};

export type MemoryGraphData = {
  entities: Entity[];
  relations: Relation[];
  nextId: number;
};

export type ConversationSummary = {
  summary: string;
  lastCompactedAt: string;
  messagesSummarized: number;
};

export type EmbeddingEntry = {
  id: string; // observation ID
  vector: number[];
};

export type EmbeddingIndex = {
  model: string;
  entries: EmbeddingEntry[];
};

export type MemoryConfig = {
  dir: string;
  /** Model used for memory's internal LLM calls (extraction, recall,
   *  forget, compaction, summary merge). Resolution order:
   *  this field > the top-level `defaultModel` from `agency.json` >
   *  the hardcoded fallback (`"gpt-4o-mini"`). Set this when you want
   *  a specific cheap model for memory work that differs from the
   *  agent's primary model. */
  model?: string;
  autoExtract?: {
    interval?: number;
  };
  compaction?: {
    trigger?: "token" | "messages";
    threshold?: number;
  };
  embeddings?: {
    model?: string;
  };
};

export type MemoryStore = {
  loadGraph(memoryId: string): Promise<MemoryGraphData>;
  saveGraph(memoryId: string, graph: MemoryGraphData): Promise<void>;
  loadEmbeddings(memoryId: string): Promise<EmbeddingIndex | null>;
  saveEmbeddings(memoryId: string, index: EmbeddingIndex): Promise<void>;
  loadSummary(memoryId: string): Promise<ConversationSummary | null>;
  saveSummary(memoryId: string, summary: ConversationSummary): Promise<void>;
};

// ---- Zod schemas for persisted data ----
//
// These guard the file-backed `MemoryStore`. They validate on save so a
// shape regression in code surfaces immediately, and on load so a
// hand-edited or corrupted file fails loudly with the offending path
// rather than silently propagating bad data through the recall pipeline.

const ObservationSchema = z.object({
  id: z.string(),
  content: z.string(),
  validFrom: z.string(),
  validTo: z.string().nullable(),
});

const EntitySchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  source: z.string(),
  createdAt: z.string(),
  observations: z.array(ObservationSchema),
});

const RelationSchema = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  type: z.string(),
  source: z.string(),
  validFrom: z.string(),
  validTo: z.string().nullable(),
});

export const MemoryGraphDataSchema = z.object({
  entities: z.array(EntitySchema),
  relations: z.array(RelationSchema),
  nextId: z.number(),
});

export const EmbeddingIndexSchema = z.object({
  model: z.string(),
  entries: z.array(
    z.object({
      id: z.string(),
      vector: z.array(z.number()),
    }),
  ),
});

export const ConversationSummarySchema = z.object({
  summary: z.string(),
  lastCompactedAt: z.string(),
  messagesSummarized: z.number(),
});
