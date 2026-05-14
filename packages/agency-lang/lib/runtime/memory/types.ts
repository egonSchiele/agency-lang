// Core types for the memory layer.

export type MemoryMessageRole =
  | "user"
  | "assistant"
  | "system"
  | "tool"
  | "developer";

// A minimal structural message shape used by the memory subsystem.
// Compatible with smoltalk's Message classes (which expose role/content
// via getters) but also accepts plain object literals.
export type MemoryMessage = {
  role: MemoryMessageRole;
  content: string;
};

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
