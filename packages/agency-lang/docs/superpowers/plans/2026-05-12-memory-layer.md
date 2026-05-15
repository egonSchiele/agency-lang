# Memory Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a built-in memory layer to Agency that gives agents a temporal knowledge graph, conversation compaction, and hybrid retrieval — configured via `agency.json`, accessible via `std::memory`.

**Architecture:** The memory layer is a runtime subsystem that lives alongside the existing ThreadStore and GlobalStore. It consists of a knowledge graph (entities, relations, observations with temporal validity), a file-based storage backend, DIY embeddings with cosine similarity, and LLM-powered extraction/compaction pipelines. The `std::memory` stdlib module wraps these capabilities for agent authors.

**Tech Stack:** Pure TypeScript, no new npm dependencies. Uses the existing smoltalk LLM client for extraction/compaction/retrieval calls and embedding API calls (smoltalk ^0.3.0 ships `embed()`).

**Spec:** `docs/superpowers/specs/2026-05-12-memory-layer-design.md`

---

## Resolved Decisions (2026-05-14)

These decisions were agreed with the user and supersede any conflicting guidance later in the plan. They are v1 scope.

1. **`memoryId` lives on `stateStack.other.memoryId`** (not on the MemoryManager). It is serialized as part of the StateStack (see `lib/runtime/state/stateStack.ts` `toJSON`/`fromJSON`), so it survives interrupt/resume cycles. The `MemoryManager` itself is held on `RuntimeContext` (NOT serialized — it's a handle to the disk store and LLM client), and reads the active id from `ctx.stateStack.other.memoryId` on every operation. Default id is `"default"` if unset.

2. **`MemoryManager` keeps a per-id cache** of `(MemoryGraph, EmbeddingManager, ConversationSummary)` keyed by memoryId, lazily loaded from disk on first use. Switching `memoryId` mid-run does NOT discard in-memory state — it just selects a different cache entry. There is one MemoryManager per RuntimeContext (per agent run).

3. **Persist on every write.** `remember`, `forget`, and the auto-extract / compaction paths all call `store.saveGraph` / `saveEmbeddings` / `saveSummary` immediately after mutating in-memory state. No file locking — single-writer-per-memoryId is a documented v1 constraint.

4. **Retrieval is union-of-tiers, top-K** (NOT first-match-wins). `recall()` runs all three tiers, dedupes results by entity id, keeps top K (default 10) ordered by structured-match-first then embedding score then LLM-rank, and formats the union. `recallForInjection()` runs tiers 1+2 only and returns top K.

5. **Compaction respects message boundaries.**
    - Compute target split point ≈ `floor(messages.length / 2)`.
    - Walk forward from that index until the message at the boundary is a `user` message (so we never split between an `assistant` with `tool_calls` and its corresponding `tool` replies). If we walk to the end without finding one, do not compact this turn.
    - The compacted prefix is rolled into a single natural-language summary; `tool_call` / `tool` messages in the prefix are intentionally dropped (their information lives in the summary). System messages at the head of the thread are preserved verbatim before the summary.

6. **`memory: true` on `llm()` triggers retrieval/injection only.** Auto-extraction (`onTurn`) and `compactIfNeeded` run unconditionally whenever `ctx.memoryManager` is present, regardless of any per-call option.

7. **`forget` is soft-delete with substring matching** (user-facing, forgiving). Extraction `expirations` use exact-equality matching (automated, only fires on genuine contradictions). Both set `validTo`; nothing is hard-deleted.

8. **Smoltalk `embed()` signature.** Smoltalk ^0.3.0 exports:
    ```ts
    embed(input: string | string[], config: EmbedConfig): Promise<Result<EmbedResult>>
    // EmbedResult = { embeddings: number[][]; model: string; tokenUsage?; costEstimate? }
    ```
    The MemoryManager's `LlmClient.embed()` adapter must call this and unwrap `result.embeddings[0]`. Failures (no API key, network error, non-embedding provider) are caught and treated as "no embedding produced" — Tier 2 silently no-ops.

9. **CI tests use the deterministic LLM client** (`lib/runtime/deterministicClient.ts`). Tests that need extraction/compaction/recall fixtures register canned responses there. Locally, real LLM calls are allowed but should not be required by CI. Unit tests of `MemoryManager` continue to use vitest mocks.

10. **stdlib access pattern.** `lib/stdlib/memory.ts` functions retrieve the active `MemoryManager` via the same module-singleton pattern other stdlib modules use to reach runtime state. Inspect `lib/stdlib/builtins.ts` (e.g. `_print`, `_input`) and any existing helper that exposes the current `RuntimeContext` to TS stdlib code; reuse that mechanism. If no such helper exists yet, add a tiny one in `lib/runtime/` (e.g. `setCurrentContext` / `getCurrentContext`) called from `setupNode` and torn down in node teardown — model it on how `traceWriter` or `statelogClient` are wired.

11. **Typechecker pattern for awaited promises.** Confirmed by `stdlib/wikipedia.agency` + `lib/stdlib/wikipedia.ts`: TS function returns `Promise<T>`, Agency wrapper declares `: T`. Runtime auto-awaits. So `_recall(...)` → `Promise<string>` paired with Agency `recall(query): string` is correct.

12. **Out of scope for v1:** file locking, multi-writer coordination, hard delete / GDPR purge, per-source filtering on stdlib API (extraction still tags `source`), memory migration tooling, custom embedding providers beyond what smoltalk supports.

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `lib/runtime/memory/types.ts` | Core types: Entity, Observation, Relation, MemoryGraph, ConversationSummary, EmbeddingIndex |
| `lib/runtime/memory/graph.ts` | MemoryGraph class: CRUD operations on entities, relations, observations with temporal logic |
| `lib/runtime/memory/store.ts` | MemoryStore interface + FileMemoryStore implementation (JSON file I/O) |
| `lib/runtime/memory/embeddings.ts` | Embedding generation (API call) + cosine similarity + EmbeddingIndex management |
| `lib/runtime/memory/extraction.ts` | LLM-powered fact extraction pipeline (auto-extract + manual remember) |
| `lib/runtime/memory/compaction.ts` | Compaction pipeline: summarize-and-replace older messages |
| `lib/runtime/memory/retrieval.ts` | Three-tier retrieval: structured lookup, embedding similarity, LLM-powered |
| `lib/runtime/memory/manager.ts` | MemoryManager class: orchestrates all subsystems, handles lazy init, auto-extract intervals |
| `lib/runtime/memory/index.ts` | Public exports |
| `lib/stdlib/memory.ts` | TypeScript implementation for std::memory functions |
| `stdlib/memory.agency` | Agency wrapper for std::memory (setMemoryId, remember, recall, forget) |
| `lib/runtime/memory/graph.test.ts` | Tests for MemoryGraph |
| `lib/runtime/memory/store.test.ts` | Tests for FileMemoryStore |
| `lib/runtime/memory/embeddings.test.ts` | Tests for embedding + cosine similarity |
| `lib/runtime/memory/extraction.test.ts` | Tests for extraction pipeline |
| `lib/runtime/memory/compaction.test.ts` | Tests for compaction pipeline |
| `lib/runtime/memory/retrieval.test.ts` | Tests for three-tier retrieval |
| `lib/runtime/memory/manager.test.ts` | Tests for MemoryManager orchestration |
| `tests/agency/memory/` | Agency execution tests for std::memory |

### Modified Files

| File | Change |
|------|--------|
| `lib/config.ts` | Add `memory` field to AgencyConfig interface + Zod schema |
| `lib/typeChecker/builtins.ts` | Add `memory` option to llmOptions type |
| `lib/runtime/prompt.ts` | Hook memory retrieval into `_runPrompt()` when `memory` option is set |
| `lib/runtime/node.ts` | Initialize MemoryManager in `setupNode()` if config has memory |
| `lib/runtime/context.ts` | Add optional `memoryManager` to RuntimeContext |

---

## Task 1: Core Types

**Files:**
- Create: `lib/runtime/memory/types.ts`
- Test: `lib/runtime/memory/graph.test.ts` (type import verification only)

- [ ] **Step 1: Define core types**

```typescript
// lib/runtime/memory/types.ts
import type { Message } from "smoltalk";

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
```

- [ ] **Step 2: Create index file**

```typescript
// lib/runtime/memory/index.ts
export * from "./types.js";
export { MemoryGraph } from "./graph.js";
export { FileMemoryStore } from "./store.js";
export { MemoryManager } from "./manager.js";
```

Note: this will have import errors until later tasks create the referenced files. That's fine — we'll build them incrementally.

- [ ] **Step 3: Commit**

```bash
git add lib/runtime/memory/types.ts lib/runtime/memory/index.ts
git commit -m "Add core types for memory layer"
```

---

## Task 2: MemoryGraph Class

**Files:**
- Create: `lib/runtime/memory/graph.ts`
- Create: `lib/runtime/memory/graph.test.ts`

- [ ] **Step 1: Write failing tests for MemoryGraph**

```typescript
// lib/runtime/memory/graph.test.ts
import { describe, it, expect } from "vitest";
import { MemoryGraph } from "./graph.js";

describe("MemoryGraph", () => {
  it("starts empty", () => {
    const graph = new MemoryGraph();
    expect(graph.getEntities()).toEqual([]);
    expect(graph.getRelations()).toEqual([]);
  });

  it("adds an entity", () => {
    const graph = new MemoryGraph();
    const entity = graph.addEntity("Mom", "person", "gifting-agent");
    expect(entity.name).toBe("Mom");
    expect(entity.type).toBe("person");
    expect(entity.source).toBe("gifting-agent");
    expect(entity.observations).toEqual([]);
    expect(graph.getEntities()).toHaveLength(1);
  });

  it("adds an observation to an entity", () => {
    const graph = new MemoryGraph();
    const entity = graph.addEntity("Mom", "person", "gifting-agent");
    const obs = graph.addObservation(entity.id, "Likes pottery");
    expect(obs.content).toBe("Likes pottery");
    expect(obs.validFrom).toBeTruthy();
    expect(obs.validTo).toBeNull();
  });

  it("expires an observation", () => {
    const graph = new MemoryGraph();
    const entity = graph.addEntity("Mom", "person", "gifting-agent");
    const obs = graph.addObservation(entity.id, "Favorite color is blue");
    graph.expireObservation(obs.id);
    const updated = graph.getEntity(entity.id);
    expect(updated!.observations[0].validTo).toBeTruthy();
  });

  it("adds a relation between entities", () => {
    const graph = new MemoryGraph();
    const user = graph.addEntity("User", "user", "system");
    const mom = graph.addEntity("Mom", "person", "gifting-agent");
    const rel = graph.addRelation(user.id, mom.id, "mother-of", "gifting-agent");
    expect(rel.from).toBe(user.id);
    expect(rel.to).toBe(mom.id);
    expect(rel.type).toBe("mother-of");
    expect(graph.getRelations()).toHaveLength(1);
  });

  it("finds entity by name (case-insensitive)", () => {
    const graph = new MemoryGraph();
    graph.addEntity("Mom", "person", "gifting-agent");
    expect(graph.findEntityByName("mom")).toBeTruthy();
    expect(graph.findEntityByName("Mom")).toBeTruthy();
    expect(graph.findEntityByName("Dad")).toBeNull();
  });

  it("gets current observations only", () => {
    const graph = new MemoryGraph();
    const entity = graph.addEntity("Mom", "person", "gifting-agent");
    graph.addObservation(entity.id, "Favorite color is blue");
    graph.addObservation(entity.id, "Likes pottery");
    // expire the first one
    const obs = graph.getEntity(entity.id)!.observations[0];
    graph.expireObservation(obs.id);
    const current = graph.getCurrentObservations(entity.id);
    expect(current).toHaveLength(1);
    expect(current[0].content).toBe("Likes pottery");
  });

  it("serializes to and from JSON", () => {
    const graph = new MemoryGraph();
    const entity = graph.addEntity("Mom", "person", "gifting-agent");
    graph.addObservation(entity.id, "Likes pottery");
    const json = graph.toJSON();
    const restored = MemoryGraph.fromJSON(json);
    expect(restored.getEntities()).toHaveLength(1);
    expect(restored.getEntities()[0].observations).toHaveLength(1);
  });

  it("finds entities by type", () => {
    const graph = new MemoryGraph();
    graph.addEntity("Mom", "person", "gifting-agent");
    graph.addEntity("Dad", "person", "gifting-agent");
    graph.addEntity("Pottery", "category", "gifting-agent");
    const people = graph.findEntitiesByType("person");
    expect(people).toHaveLength(2);
  });

  it("finds relations by entity", () => {
    const graph = new MemoryGraph();
    const user = graph.addEntity("User", "user", "system");
    const mom = graph.addEntity("Mom", "person", "gifting-agent");
    const dad = graph.addEntity("Dad", "person", "gifting-agent");
    graph.addRelation(user.id, mom.id, "mother-of", "gifting-agent");
    graph.addRelation(user.id, dad.id, "father-of", "gifting-agent");
    const rels = graph.getRelationsFrom(user.id);
    expect(rels).toHaveLength(2);
  });

  it("expires a relation", () => {
    const graph = new MemoryGraph();
    const user = graph.addEntity("User", "user", "system");
    const mom = graph.addEntity("Mom", "person", "gifting-agent");
    const rel = graph.addRelation(user.id, mom.id, "likes", "gifting-agent");
    graph.expireRelation(rel.id);
    const updated = graph.getRelations()[0];
    expect(updated.validTo).toBeTruthy();
  });

  it("generates a compact index for LLM context", () => {
    const graph = new MemoryGraph();
    const mom = graph.addEntity("Mom", "person", "gifting-agent");
    graph.addObservation(mom.id, "Likes pottery");
    const index = graph.toCompactIndex();
    expect(index).toContain("Mom");
    expect(index).toContain("person");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test:run lib/runtime/memory/graph.test.ts 2>&1 | tee /tmp/graph-test-1.log`
Expected: FAIL — module not found

- [ ] **Step 3: Implement MemoryGraph**

```typescript
// lib/runtime/memory/graph.ts
import type { Entity, Observation, Relation, MemoryGraphData } from "./types.js";

export class MemoryGraph {
  private entities: Entity[] = [];
  private relations: Relation[] = [];
  private nextId = 1;

  private genId(prefix: string): string {
    return `${prefix}-${this.nextId++}`;
  }

  private now(): string {
    return new Date().toISOString();
  }

  getEntities(): Entity[] {
    return this.entities;
  }

  getRelations(): Relation[] {
    return this.relations;
  }

  getEntity(id: string): Entity | null {
    return this.entities.find((e) => e.id === id) ?? null;
  }

  addEntity(name: string, type: string, source: string): Entity {
    const entity: Entity = {
      id: this.genId("entity"),
      name,
      type,
      source,
      createdAt: this.now(),
      observations: [],
    };
    this.entities.push(entity);
    return entity;
  }

  addObservation(entityId: string, content: string): Observation {
    const entity = this.getEntity(entityId);
    if (!entity) throw new Error(`Entity ${entityId} not found`);
    const obs: Observation = {
      id: this.genId("obs"),
      content,
      validFrom: this.now(),
      validTo: null,
    };
    entity.observations.push(obs);
    return obs;
  }

  expireObservation(obsId: string): void {
    for (const entity of this.entities) {
      const obs = entity.observations.find((o) => o.id === obsId);
      if (obs) {
        obs.validTo = this.now();
        return;
      }
    }
  }

  addRelation(fromId: string, toId: string, type: string, source: string): Relation {
    const rel: Relation = {
      id: this.genId("rel"),
      from: fromId,
      to: toId,
      type,
      source,
      validFrom: this.now(),
      validTo: null,
    };
    this.relations.push(rel);
    return rel;
  }

  expireRelation(relId: string): void {
    const rel = this.relations.find((r) => r.id === relId);
    if (rel) rel.validTo = this.now();
  }

  findEntityByName(name: string): Entity | null {
    const lower = name.toLowerCase();
    return this.entities.find((e) => e.name.toLowerCase() === lower) ?? null;
  }

  findEntitiesByType(type: string): Entity[] {
    return this.entities.filter((e) => e.type === type);
  }

  getCurrentObservations(entityId: string): Observation[] {
    const entity = this.getEntity(entityId);
    if (!entity) return [];
    return entity.observations.filter((o) => o.validTo === null);
  }

  getRelationsFrom(entityId: string): Relation[] {
    return this.relations.filter((r) => r.from === entityId && r.validTo === null);
  }

  getRelationsTo(entityId: string): Relation[] {
    return this.relations.filter((r) => r.to === entityId && r.validTo === null);
  }

  toCompactIndex(): string {
    const lines: string[] = [];
    for (const entity of this.entities) {
      const current = this.getCurrentObservations(entity.id);
      const obsStr = current.map((o) => o.content).join("; ");
      const relFrom = this.getRelationsFrom(entity.id);
      const relStr = relFrom
        .map((r) => {
          const target = this.getEntity(r.to);
          return `${r.type} → ${target?.name ?? r.to}`;
        })
        .join("; ");
      let line = `${entity.name} (${entity.type})`;
      if (obsStr) line += `: ${obsStr}`;
      if (relStr) line += ` [${relStr}]`;
      lines.push(line);
    }
    return lines.join("\n");
  }

  toJSON(): MemoryGraphData {
    return {
      entities: this.entities,
      relations: this.relations,
      nextId: this.nextId,
    };
  }

  static fromJSON(data: MemoryGraphData): MemoryGraph {
    const graph = new MemoryGraph();
    graph.entities = data.entities;
    graph.relations = data.relations;
    graph.nextId = data.nextId;
    return graph;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test:run lib/runtime/memory/graph.test.ts 2>&1 | tee /tmp/graph-test-2.log`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/memory/graph.ts lib/runtime/memory/graph.test.ts
git commit -m "Add MemoryGraph class with temporal entity-relationship model"
```

---

## Task 3: FileMemoryStore

**Files:**
- Create: `lib/runtime/memory/store.ts`
- Create: `lib/runtime/memory/store.test.ts`

- [ ] **Step 1: Write failing tests for FileMemoryStore**

```typescript
// lib/runtime/memory/store.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FileMemoryStore } from "./store.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

describe("FileMemoryStore", () => {
  let tmpDir: string;
  let store: FileMemoryStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-test-"));
    store = new FileMemoryStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty graph for new memoryId", async () => {
    const graph = await store.loadGraph("user-1");
    expect(graph.entities).toEqual([]);
    expect(graph.relations).toEqual([]);
    expect(graph.nextId).toBe(1);
  });

  it("saves and loads a graph", async () => {
    const data = {
      entities: [{ id: "entity-1", name: "Mom", type: "person", source: "test", createdAt: "2026-01-01", observations: [] }],
      relations: [],
      nextId: 2,
    };
    await store.saveGraph("user-1", data);
    const loaded = await store.loadGraph("user-1");
    expect(loaded.entities).toHaveLength(1);
    expect(loaded.entities[0].name).toBe("Mom");
  });

  it("returns null summary for new memoryId", async () => {
    const summary = await store.loadSummary("user-1");
    expect(summary).toBeNull();
  });

  it("saves and loads a summary", async () => {
    const summary = { summary: "User discussed gifts", lastCompactedAt: "2026-01-01", messagesSummarized: 10 };
    await store.saveSummary("user-1", summary);
    const loaded = await store.loadSummary("user-1");
    expect(loaded).toEqual(summary);
  });

  it("returns null embeddings for new memoryId", async () => {
    const embeddings = await store.loadEmbeddings("user-1");
    expect(embeddings).toBeNull();
  });

  it("saves and loads embeddings", async () => {
    const index = { model: "text-embedding-3-small", entries: [{ id: "obs-1", vector: [0.1, 0.2, 0.3] }] };
    await store.saveEmbeddings("user-1", index);
    const loaded = await store.loadEmbeddings("user-1");
    expect(loaded).toEqual(index);
  });

  it("isolates different memoryIds", async () => {
    const data1 = { entities: [{ id: "e-1", name: "Mom", type: "person", source: "test", createdAt: "2026-01-01", observations: [] }], relations: [], nextId: 2 };
    const data2 = { entities: [{ id: "e-1", name: "Dad", type: "person", source: "test", createdAt: "2026-01-01", observations: [] }], relations: [], nextId: 2 };
    await store.saveGraph("user-1", data1);
    await store.saveGraph("user-2", data2);
    const loaded1 = await store.loadGraph("user-1");
    const loaded2 = await store.loadGraph("user-2");
    expect(loaded1.entities[0].name).toBe("Mom");
    expect(loaded2.entities[0].name).toBe("Dad");
  });

  it("creates directory structure on save", async () => {
    const data = { entities: [], relations: [], nextId: 1 };
    await store.saveGraph("new-user", data);
    const dirExists = fs.existsSync(path.join(tmpDir, "new-user"));
    expect(dirExists).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test:run lib/runtime/memory/store.test.ts 2>&1 | tee /tmp/store-test-1.log`
Expected: FAIL — module not found

- [ ] **Step 3: Implement FileMemoryStore**

```typescript
// lib/runtime/memory/store.ts
import type { MemoryGraphData, ConversationSummary, EmbeddingIndex, MemoryStore } from "./types.js";
import fs from "node:fs";
import path from "node:path";

export class FileMemoryStore implements MemoryStore {
  constructor(private baseDir: string) {}

  private dir(memoryId: string): string {
    return path.join(this.baseDir, memoryId);
  }

  private ensureDir(memoryId: string): void {
    const dir = this.dir(memoryId);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  private async readJSON<T>(filePath: string): Promise<T | null> {
    if (!fs.existsSync(filePath)) return null;
    const content = await fs.promises.readFile(filePath, "utf-8");
    return JSON.parse(content);
  }

  private async writeJSON(filePath: string, data: unknown): Promise<void> {
    await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
  }

  async loadGraph(memoryId: string): Promise<MemoryGraphData> {
    const filePath = path.join(this.dir(memoryId), "graph.json");
    const data = await this.readJSON<MemoryGraphData>(filePath);
    return data ?? { entities: [], relations: [], nextId: 1 };
  }

  async saveGraph(memoryId: string, graph: MemoryGraphData): Promise<void> {
    this.ensureDir(memoryId);
    const filePath = path.join(this.dir(memoryId), "graph.json");
    await this.writeJSON(filePath, graph);
  }

  async loadEmbeddings(memoryId: string): Promise<EmbeddingIndex | null> {
    const filePath = path.join(this.dir(memoryId), "embeddings.json");
    return this.readJSON<EmbeddingIndex>(filePath);
  }

  async saveEmbeddings(memoryId: string, index: EmbeddingIndex): Promise<void> {
    this.ensureDir(memoryId);
    const filePath = path.join(this.dir(memoryId), "embeddings.json");
    await this.writeJSON(filePath, index);
  }

  async loadSummary(memoryId: string): Promise<ConversationSummary | null> {
    const filePath = path.join(this.dir(memoryId), "summary.json");
    return this.readJSON<ConversationSummary>(filePath);
  }

  async saveSummary(memoryId: string, summary: ConversationSummary): Promise<void> {
    this.ensureDir(memoryId);
    const filePath = path.join(this.dir(memoryId), "summary.json");
    await this.writeJSON(filePath, summary);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test:run lib/runtime/memory/store.test.ts 2>&1 | tee /tmp/store-test-2.log`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/memory/store.ts lib/runtime/memory/store.test.ts
git commit -m "Add FileMemoryStore for JSON-based memory persistence"
```

---

## Task 4: Embeddings and Cosine Similarity

**Files:**
- Create: `lib/runtime/memory/embeddings.ts`
- Create: `lib/runtime/memory/embeddings.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// lib/runtime/memory/embeddings.test.ts
import { describe, it, expect } from "vitest";
import { cosineSimilarity, EmbeddingManager } from "./embeddings.js";

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    const v = [1, 2, 3];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0.0);
  });

  it("returns -1 for opposite vectors", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1.0);
  });

  it("handles high-dimensional vectors", () => {
    const a = Array.from({ length: 1536 }, (_, i) => Math.sin(i));
    const b = Array.from({ length: 1536 }, (_, i) => Math.sin(i + 0.1));
    const sim = cosineSimilarity(a, b);
    expect(sim).toBeGreaterThan(0.9);
    expect(sim).toBeLessThanOrEqual(1.0);
  });
});

describe("EmbeddingManager", () => {
  it("finds top-k similar entries", () => {
    const manager = new EmbeddingManager();
    // Manually set entries (bypassing API calls for testing)
    manager.setEntries([
      { id: "obs-1", vector: [1, 0, 0] },
      { id: "obs-2", vector: [0, 1, 0] },
      { id: "obs-3", vector: [0.9, 0.1, 0] },
    ]);
    const results = manager.findSimilar([1, 0, 0], 2);
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe("obs-1"); // exact match first
    expect(results[1].id).toBe("obs-3"); // close match second
  });

  it("filters by minimum threshold", () => {
    const manager = new EmbeddingManager();
    manager.setEntries([
      { id: "obs-1", vector: [1, 0, 0] },
      { id: "obs-2", vector: [0, 1, 0] }, // orthogonal — should be excluded
    ]);
    const results = manager.findSimilar([1, 0, 0], 10, 0.5);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("obs-1");
  });

  it("serializes to and from EmbeddingIndex", () => {
    const manager = new EmbeddingManager();
    manager.setModel("test-model");
    manager.setEntries([{ id: "obs-1", vector: [1, 2, 3] }]);
    const index = manager.toIndex();
    expect(index.model).toBe("test-model");
    expect(index.entries).toHaveLength(1);

    const restored = EmbeddingManager.fromIndex(index);
    expect(restored.findSimilar([1, 2, 3], 1)[0].id).toBe("obs-1");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test:run lib/runtime/memory/embeddings.test.ts 2>&1 | tee /tmp/embeddings-test-1.log`
Expected: FAIL — module not found

- [ ] **Step 3: Implement embeddings module**

```typescript
// lib/runtime/memory/embeddings.ts
import type { EmbeddingEntry, EmbeddingIndex } from "./types.js";

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  if (denom === 0) return 0;
  return dot / denom;
}

export type SimilarityResult = {
  id: string;
  score: number;
};

export class EmbeddingManager {
  private entries: EmbeddingEntry[] = [];
  private model = "text-embedding-3-small";

  setModel(model: string): void {
    this.model = model;
  }

  setEntries(entries: EmbeddingEntry[]): void {
    this.entries = entries;
  }

  addEntry(id: string, vector: number[]): void {
    // Remove existing entry with same ID if present
    this.entries = this.entries.filter((e) => e.id !== id);
    this.entries.push({ id, vector });
  }

  removeEntry(id: string): void {
    this.entries = this.entries.filter((e) => e.id !== id);
  }

  findSimilar(queryVector: number[], topK: number, minThreshold = 0.0): SimilarityResult[] {
    const scored = this.entries
      .map((entry) => ({
        id: entry.id,
        score: cosineSimilarity(queryVector, entry.vector),
      }))
      .filter((r) => r.score >= minThreshold);
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  toIndex(): EmbeddingIndex {
    return { model: this.model, entries: this.entries };
  }

  static fromIndex(index: EmbeddingIndex): EmbeddingManager {
    const manager = new EmbeddingManager();
    manager.model = index.model;
    manager.entries = index.entries;
    return manager;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test:run lib/runtime/memory/embeddings.test.ts 2>&1 | tee /tmp/embeddings-test-2.log`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/memory/embeddings.ts lib/runtime/memory/embeddings.test.ts
git commit -m "Add embeddings with cosine similarity for memory retrieval"
```

---

## Task 5: Extraction Pipeline

**Files:**
- Create: `lib/runtime/memory/extraction.ts`
- Create: `lib/runtime/memory/extraction.test.ts`

This task implements the LLM-powered fact extraction. Tests use a mock LLM client since we don't want real API calls in tests.

- [ ] **Step 1: Write failing tests**

```typescript
// lib/runtime/memory/extraction.test.ts
import { describe, it, expect } from "vitest";
import { buildExtractionPrompt, applyExtractionResult } from "./extraction.js";
import { MemoryGraph } from "./graph.js";

describe("buildExtractionPrompt", () => {
  it("includes conversation messages in the prompt", () => {
    const messages = [
      { role: "user" as const, content: "My mom loves pottery" },
      { role: "assistant" as const, content: "That's great!" },
    ];
    const graph = new MemoryGraph();
    const prompt = buildExtractionPrompt(messages, graph);
    expect(prompt).toContain("My mom loves pottery");
  });

  it("includes existing entities for deduplication context", () => {
    const graph = new MemoryGraph();
    graph.addEntity("Mom", "person", "test");
    const prompt = buildExtractionPrompt([], graph);
    expect(prompt).toContain("Mom");
    expect(prompt).toContain("person");
  });
});

describe("applyExtractionResult", () => {
  it("adds new entities from extraction", () => {
    const graph = new MemoryGraph();
    const result = {
      entities: [{ name: "Mom", type: "person", observations: ["Likes pottery"] }],
      relations: [],
      expirations: [],
    };
    applyExtractionResult(graph, result, "test-agent");
    expect(graph.getEntities()).toHaveLength(1);
    expect(graph.getEntities()[0].observations).toHaveLength(1);
  });

  it("merges observations into existing entity by name", () => {
    const graph = new MemoryGraph();
    graph.addEntity("Mom", "person", "test");
    graph.addObservation(graph.findEntityByName("Mom")!.id, "Birthday is March 5");
    const result = {
      entities: [{ name: "Mom", type: "person", observations: ["Likes pottery"] }],
      relations: [],
      expirations: [],
    };
    applyExtractionResult(graph, result, "test-agent");
    expect(graph.getEntities()).toHaveLength(1); // no duplicate entity
    expect(graph.getEntities()[0].observations).toHaveLength(2); // both observations
  });

  it("adds relations from extraction", () => {
    const graph = new MemoryGraph();
    graph.addEntity("User", "user", "test");
    graph.addEntity("Mom", "person", "test");
    const result = {
      entities: [],
      relations: [{ from: "User", to: "Mom", type: "mother-of" }],
      expirations: [],
    };
    applyExtractionResult(graph, result, "test-agent");
    expect(graph.getRelations()).toHaveLength(1);
  });

  it("expires old observations on contradiction", () => {
    const graph = new MemoryGraph();
    const mom = graph.addEntity("Mom", "person", "test");
    const obs = graph.addObservation(mom.id, "Favorite color is blue");
    const result = {
      entities: [{ name: "Mom", type: "person", observations: ["Favorite color is red"] }],
      relations: [],
      expirations: [{ entityName: "Mom", observationContent: "Favorite color is blue" }],
    };
    applyExtractionResult(graph, result, "test-agent");
    const current = graph.getCurrentObservations(mom.id);
    expect(current).toHaveLength(1);
    expect(current[0].content).toBe("Favorite color is red");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test:run lib/runtime/memory/extraction.test.ts 2>&1 | tee /tmp/extraction-test-1.log`
Expected: FAIL — module not found

- [ ] **Step 3: Implement extraction module**

```typescript
// lib/runtime/memory/extraction.ts
import type { Message } from "smoltalk";
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
    observationContent: string; // content of the observation to expire
  }>;
};

export function buildExtractionPrompt(messages: Message[], graph: MemoryGraph): string {
  const existingEntities = graph.getEntities();
  const entityContext =
    existingEntities.length > 0
      ? `\n\nExisting entities in the knowledge graph (merge with these, do not duplicate):\n${graph.toCompactIndex()}`
      : "";

  const conversationText = messages
    .map((m) => `${m.role}: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`)
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

export function applyExtractionResult(
  graph: MemoryGraph,
  result: ExtractionResult,
  source: string
): string[] {
  const newObservationIds: string[] = [];

  // Apply expirations first
  for (const exp of result.expirations) {
    const entity = graph.findEntityByName(exp.entityName);
    if (!entity) continue;
    const obs = entity.observations.find(
      (o) => o.validTo === null && o.content.toLowerCase() === exp.observationContent.toLowerCase()
    );
    if (obs) graph.expireObservation(obs.id);
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

  return newObservationIds;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test:run lib/runtime/memory/extraction.test.ts 2>&1 | tee /tmp/extraction-test-2.log`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/memory/extraction.ts lib/runtime/memory/extraction.test.ts
git commit -m "Add LLM extraction pipeline for memory fact extraction"
```

---

## Task 6: Retrieval Pipeline

**Files:**
- Create: `lib/runtime/memory/retrieval.ts`
- Create: `lib/runtime/memory/retrieval.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// lib/runtime/memory/retrieval.test.ts
import { describe, it, expect } from "vitest";
import { structuredLookup, formatRetrievalResults, buildRetrievalPrompt } from "./retrieval.js";
import { MemoryGraph } from "./graph.js";

describe("structuredLookup", () => {
  it("finds entities by name substring", () => {
    const graph = new MemoryGraph();
    const mom = graph.addEntity("Mom", "person", "test");
    graph.addObservation(mom.id, "Likes pottery");
    graph.addEntity("Dad", "person", "test");
    const results = structuredLookup(graph, "mom");
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("Mom");
  });

  it("finds entities by type", () => {
    const graph = new MemoryGraph();
    graph.addEntity("Mom", "person", "test");
    graph.addEntity("Pottery", "category", "test");
    const results = structuredLookup(graph, "person");
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("Mom");
  });

  it("finds entities by observation content", () => {
    const graph = new MemoryGraph();
    const mom = graph.addEntity("Mom", "person", "test");
    graph.addObservation(mom.id, "Likes pottery");
    const dad = graph.addEntity("Dad", "person", "test");
    graph.addObservation(dad.id, "Likes fishing");
    const results = structuredLookup(graph, "pottery");
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("Mom");
  });

  it("returns empty for no matches", () => {
    const graph = new MemoryGraph();
    graph.addEntity("Mom", "person", "test");
    const results = structuredLookup(graph, "xyz123");
    expect(results).toHaveLength(0);
  });

  it("filters by source when specified", () => {
    const graph = new MemoryGraph();
    graph.addEntity("Mom", "person", "gifting-agent");
    graph.addEntity("Mom", "person", "support-bot");
    const results = structuredLookup(graph, "mom", { source: "gifting-agent" });
    expect(results).toHaveLength(1);
    expect(results[0].source).toBe("gifting-agent");
  });
});

describe("formatRetrievalResults", () => {
  it("formats entities with observations as readable text", () => {
    const graph = new MemoryGraph();
    const mom = graph.addEntity("Mom", "person", "test");
    graph.addObservation(mom.id, "Likes pottery");
    graph.addObservation(mom.id, "Birthday is March 5");
    const entities = [graph.getEntity(mom.id)!];
    const text = formatRetrievalResults(graph, entities);
    expect(text).toContain("Mom");
    expect(text).toContain("Likes pottery");
    expect(text).toContain("Birthday is March 5");
  });

  it("includes relations in formatted output", () => {
    const graph = new MemoryGraph();
    const user = graph.addEntity("User", "user", "test");
    const mom = graph.addEntity("Mom", "person", "test");
    graph.addRelation(user.id, mom.id, "mother-of", "test");
    const entities = graph.getEntities();
    const text = formatRetrievalResults(graph, entities);
    expect(text).toContain("mother-of");
  });

  it("returns empty string for no results", () => {
    const graph = new MemoryGraph();
    const text = formatRetrievalResults(graph, []);
    expect(text).toBe("");
  });
});

describe("buildRetrievalPrompt", () => {
  it("includes the query and graph index", () => {
    const graph = new MemoryGraph();
    const mom = graph.addEntity("Mom", "person", "test");
    graph.addObservation(mom.id, "Likes pottery");
    const prompt = buildRetrievalPrompt("what does mom like?", graph);
    expect(prompt).toContain("what does mom like?");
    expect(prompt).toContain("Mom");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test:run lib/runtime/memory/retrieval.test.ts 2>&1 | tee /tmp/retrieval-test-1.log`
Expected: FAIL — module not found

- [ ] **Step 3: Implement retrieval module**

```typescript
// lib/runtime/memory/retrieval.ts
import type { Entity } from "./types.js";
import { MemoryGraph } from "./graph.js";

type LookupOptions = {
  source?: string;
};

export function structuredLookup(graph: MemoryGraph, query: string, options?: LookupOptions): Entity[] {
  const lower = query.toLowerCase();
  const entities = graph.getEntities();

  const matches = entities.filter((entity) => {
    if (options?.source && entity.source !== options.source) return false;

    // Match by name
    if (entity.name.toLowerCase().includes(lower)) return true;

    // Match by type
    if (entity.type.toLowerCase() === lower) return true;

    // Match by current observation content
    const currentObs = graph.getCurrentObservations(entity.id);
    if (currentObs.some((o) => o.content.toLowerCase().includes(lower))) return true;

    return false;
  });

  return matches;
}

export function formatRetrievalResults(graph: MemoryGraph, entities: Entity[]): string {
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

export function buildRetrievalPrompt(query: string, graph: MemoryGraph): string {
  const index = graph.toCompactIndex();
  return `Given the following knowledge graph, identify which entities are relevant to the query. Return a JSON array of entity names.

Knowledge graph:
${index}

Query: ${query}

Return only the JSON array of entity names, e.g. ["Mom", "Dad"]. Return [] if no entities are relevant.`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test:run lib/runtime/memory/retrieval.test.ts 2>&1 | tee /tmp/retrieval-test-2.log`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/memory/retrieval.ts lib/runtime/memory/retrieval.test.ts
git commit -m "Add three-tier retrieval pipeline for memory recall"
```

---

## Task 7: Compaction Pipeline

**Files:**
- Create: `lib/runtime/memory/compaction.ts`
- Create: `lib/runtime/memory/compaction.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// lib/runtime/memory/compaction.test.ts
import { describe, it, expect } from "vitest";
import { buildCompactionPrompt, buildMergeSummaryPrompt, shouldCompact } from "./compaction.js";

describe("shouldCompact", () => {
  it("returns true when message count exceeds threshold", () => {
    const messages = Array.from({ length: 20 }, (_, i) => ({
      role: "user" as const,
      content: `message ${i}`,
    }));
    expect(shouldCompact(messages, { trigger: "messages", threshold: 10 })).toBe(true);
  });

  it("returns false when under threshold", () => {
    const messages = [{ role: "user" as const, content: "hi" }];
    expect(shouldCompact(messages, { trigger: "messages", threshold: 10 })).toBe(false);
  });

  it("estimates tokens for token-based trigger", () => {
    // rough: 1 token ≈ 4 chars
    const messages = [{ role: "user" as const, content: "a".repeat(4000) }];
    // ~1000 tokens, threshold 500
    expect(shouldCompact(messages, { trigger: "token", threshold: 500 })).toBe(true);
  });
});

describe("buildCompactionPrompt", () => {
  it("includes messages to summarize", () => {
    const messages = [
      { role: "user" as const, content: "I want a gift for mom" },
      { role: "assistant" as const, content: "What does she like?" },
    ];
    const prompt = buildCompactionPrompt(messages);
    expect(prompt).toContain("I want a gift for mom");
    expect(prompt).toContain("What does she like?");
  });
});

describe("buildMergeSummaryPrompt", () => {
  it("includes both old and new summaries", () => {
    const prompt = buildMergeSummaryPrompt("Old summary text", "New summary text");
    expect(prompt).toContain("Old summary text");
    expect(prompt).toContain("New summary text");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test:run lib/runtime/memory/compaction.test.ts 2>&1 | tee /tmp/compaction-test-1.log`
Expected: FAIL — module not found

- [ ] **Step 3: Implement compaction module**

```typescript
// lib/runtime/memory/compaction.ts
import type { Message } from "smoltalk";

export type CompactionConfig = {
  trigger: "token" | "messages";
  threshold: number;
};

function estimateTokens(messages: Message[]): number {
  let chars = 0;
  for (const msg of messages) {
    const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
    chars += content.length;
  }
  // rough estimate: 1 token ≈ 4 characters
  return Math.ceil(chars / 4);
}

export function shouldCompact(messages: Message[], config: CompactionConfig): boolean {
  if (config.trigger === "messages") {
    return messages.length > config.threshold;
  }
  return estimateTokens(messages) > config.threshold;
}

export function buildCompactionPrompt(messages: Message[]): string {
  const conversationText = messages
    .map((m) => `${m.role}: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`)
    .join("\n");

  return `Summarize the following conversation into a concise narrative. Preserve key facts, decisions, and context that would be important for continuing the conversation later. Do not include unnecessary detail.

Conversation:
${conversationText}

Write a concise summary:`;
}

export function buildMergeSummaryPrompt(existingSummary: string, newSummary: string): string {
  return `Merge these two conversation summaries into a single cohesive summary. The existing summary covers earlier conversation, the new summary covers more recent conversation. Preserve all key facts and decisions.

Existing summary:
${existingSummary}

New summary:
${newSummary}

Write the merged summary:`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test:run lib/runtime/memory/compaction.test.ts 2>&1 | tee /tmp/compaction-test-2.log`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/memory/compaction.ts lib/runtime/memory/compaction.test.ts
git commit -m "Add compaction pipeline for conversation summarization"
```

---

## Task 8: MemoryManager (Orchestrator)

**Files:**
- Create: `lib/runtime/memory/manager.ts`
- Create: `lib/runtime/memory/manager.test.ts`

The MemoryManager orchestrates all the subsystems: lazy init, auto-extraction scheduling, compaction, and retrieval. Tests mock the LLM client to avoid real API calls.

- [ ] **Step 1: Write failing tests**

```typescript
// lib/runtime/memory/manager.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryManager } from "./manager.js";
import { FileMemoryStore } from "./store.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Mock LLM client
function mockLlmClient() {
  return {
    text: vi.fn().mockResolvedValue(JSON.stringify({
      entities: [],
      relations: [],
      expirations: [],
    })),
    embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
  };
}

describe("MemoryManager", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-mgr-test-"));
  });

  it("defaults to 'default' memoryId", () => {
    const store = new FileMemoryStore(tmpDir);
    const manager = new MemoryManager({
      store,
      config: { dir: tmpDir },
      llmClient: mockLlmClient() as any,
    });
    expect(manager.getMemoryId()).toBe("default");
  });

  it("sets memoryId", () => {
    const store = new FileMemoryStore(tmpDir);
    const manager = new MemoryManager({
      store,
      config: { dir: tmpDir },
      llmClient: mockLlmClient() as any,
    });
    manager.setMemoryId("user-123");
    expect(manager.getMemoryId()).toBe("user-123");
  });

  it("lazily initializes on first operation", async () => {
    const store = new FileMemoryStore(tmpDir);
    const manager = new MemoryManager({
      store,
      config: { dir: tmpDir },
      llmClient: mockLlmClient() as any,
    });
    expect(manager.isInitialized()).toBe(false);
    await manager.remember("Mom likes pottery");
    expect(manager.isInitialized()).toBe(true);
  });

  it("persists graph on save", async () => {
    const store = new FileMemoryStore(tmpDir);
    const client = mockLlmClient();
    client.text.mockResolvedValue(JSON.stringify({
      entities: [{ name: "Mom", type: "person", observations: ["Likes pottery"] }],
      relations: [],
      expirations: [],
    }));
    const manager = new MemoryManager({
      store,
      config: { dir: tmpDir },
      llmClient: client as any,
    });
    await manager.remember("Mom likes pottery");
    await manager.save();

    // Load from disk in a new manager
    const manager2 = new MemoryManager({
      store,
      config: { dir: tmpDir },
      llmClient: mockLlmClient() as any,
    });
    await manager2.init();
    const entities = manager2.getGraph().getEntities();
    expect(entities).toHaveLength(1);
    expect(entities[0].name).toBe("Mom");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test:run lib/runtime/memory/manager.test.ts 2>&1 | tee /tmp/manager-test-1.log`
Expected: FAIL — module not found

- [ ] **Step 3: Implement MemoryManager**

The MemoryManager should handle:
- Lazy initialization (load from disk on first operation)
- `setMemoryId()` — sets the scope, triggers re-init if already initialized
- `remember(content)` — calls extraction pipeline, generates embeddings, stores results
- `recall(query)` — runs three-tier retrieval, returns formatted string
- `forget(query)` — uses LLM to interpret what to expire
- `recallForInjection(query)` — tiers 1+2 only, for `llm(..., { memory: true })`
- `onTurn(messages)` — called after each LLM turn, triggers auto-extraction if interval reached
- `compactIfNeeded(messages)` — checks threshold, runs compaction pipeline if needed
- `save()` — persist everything to disk
- `init()` — explicit init for loading existing state

```typescript
// lib/runtime/memory/manager.ts
import type { Message } from "smoltalk";
import type { MemoryConfig, MemoryStore as MemoryStoreType } from "./types.js";
import { MemoryGraph } from "./graph.js";
import { EmbeddingManager } from "./embeddings.js";
import { buildExtractionPrompt, applyExtractionResult } from "./extraction.js";
import type { ExtractionResult } from "./extraction.js";
import { structuredLookup, formatRetrievalResults, buildRetrievalPrompt } from "./retrieval.js";
import { shouldCompact, buildCompactionPrompt, buildMergeSummaryPrompt } from "./compaction.js";
import type { ConversationSummary } from "./types.js";

export type LlmClient = {
  text(prompt: string, options?: { model?: string; responseFormat?: any }): Promise<string>;
  embed?(text: string, options?: { model?: string }): Promise<number[]>;
};

export type MemoryManagerOptions = {
  store: MemoryStoreType;
  config: MemoryConfig;
  llmClient: LlmClient;
  source?: string;
};

export class MemoryManager {
  private store: MemoryStoreType;
  private config: MemoryConfig;
  private llmClient: LlmClient;
  private source: string;

  private memoryId = "default";
  private graph = new MemoryGraph();
  private embeddings = new EmbeddingManager();
  private summary: ConversationSummary | null = null;
  private initialized = false;
  private turnsSinceExtraction = 0;

  constructor(options: MemoryManagerOptions) {
    this.store = options.store;
    this.config = options.config;
    this.llmClient = options.llmClient;
    this.source = options.source ?? "unknown";
    if (options.config.embeddings?.model) {
      this.embeddings.setModel(options.config.embeddings.model);
    }
  }

  getMemoryId(): string {
    return this.memoryId;
  }

  setMemoryId(id: string): void {
    if (this.initialized && id !== this.memoryId) {
      // Re-init needed for new scope
      this.initialized = false;
    }
    this.memoryId = id;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  getGraph(): MemoryGraph {
    return this.graph;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    const graphData = await this.store.loadGraph(this.memoryId);
    this.graph = MemoryGraph.fromJSON(graphData);
    const embeddingIndex = await this.store.loadEmbeddings(this.memoryId);
    if (embeddingIndex) {
      this.embeddings = EmbeddingManager.fromIndex(embeddingIndex);
    }
    this.summary = await this.store.loadSummary(this.memoryId);
    this.initialized = true;
  }

  private async ensureInit(): Promise<void> {
    if (!this.initialized) await this.init();
  }

  private model(): string {
    return this.config.model ?? "gpt-4o-mini";
  }

  async remember(content: string): Promise<void> {
    await this.ensureInit();
    const messages: Message[] = [{ role: "user", content }];
    const prompt = buildExtractionPrompt(messages, this.graph);
    const response = await this.llmClient.text(prompt, { model: this.model() });
    let result: ExtractionResult;
    try {
      result = JSON.parse(response);
    } catch {
      return; // LLM returned invalid JSON, skip
    }
    const newObsIds = applyExtractionResult(this.graph, result, this.source);
    await this.generateEmbeddings(newObsIds);
  }

  async recall(query: string, options?: { model?: string }): Promise<string> {
    await this.ensureInit();

    // Tier 1: structured lookup
    const tier1 = structuredLookup(this.graph, query);
    if (tier1.length > 0) {
      return formatRetrievalResults(this.graph, tier1);
    }

    // Tier 2: embedding similarity
    const tier2 = await this.embeddingRecall(query);
    if (tier2.length > 0) {
      return tier2;
    }

    // Tier 3: LLM-powered retrieval
    const retrievalPrompt = buildRetrievalPrompt(query, this.graph);
    const model = options?.model ?? this.model();
    const response = await this.llmClient.text(retrievalPrompt, { model });
    let entityNames: string[];
    try {
      entityNames = JSON.parse(response);
    } catch {
      return "";
    }
    const entities = entityNames
      .map((name) => this.graph.findEntityByName(name))
      .filter((e): e is NonNullable<typeof e> => e !== null);
    return formatRetrievalResults(this.graph, entities);
  }

  async recallForInjection(query: string): Promise<string> {
    await this.ensureInit();

    // Tiers 1+2 only for low latency
    const tier1 = structuredLookup(this.graph, query);
    if (tier1.length > 0) {
      return formatRetrievalResults(this.graph, tier1);
    }
    return this.embeddingRecall(query);
  }

  async forget(query: string): Promise<void> {
    await this.ensureInit();
    const prompt = `Given the following knowledge graph, identify which observations should be expired based on the user's request.

Knowledge graph:
${this.graph.toCompactIndex()}

User wants to forget: ${query}

Return a JSON array of { entityName, observationContent } for observations to expire. Return [] if nothing matches.`;
    const response = await this.llmClient.text(prompt, { model: this.model() });
    let expirations: Array<{ entityName: string; observationContent: string }>;
    try {
      expirations = JSON.parse(response);
    } catch {
      return;
    }
    for (const exp of expirations) {
      const entity = this.graph.findEntityByName(exp.entityName);
      if (!entity) continue;
      const obs = entity.observations.find(
        (o) => o.validTo === null && o.content.toLowerCase().includes(exp.observationContent.toLowerCase())
      );
      if (obs) this.graph.expireObservation(obs.id);
    }
  }

  async onTurn(messages: Message[]): Promise<void> {
    await this.ensureInit();
    this.turnsSinceExtraction++;
    const interval = this.config.autoExtract?.interval ?? 5;
    if (this.turnsSinceExtraction >= interval) {
      await this.autoExtract(messages);
      this.turnsSinceExtraction = 0;
    }
  }

  async compactIfNeeded(messages: Message[]): Promise<Message[] | null> {
    await this.ensureInit();
    const compactionConfig = {
      trigger: this.config.compaction?.trigger ?? "token" as const,
      threshold: this.config.compaction?.threshold ?? 50000,
    };
    if (!shouldCompact(messages, compactionConfig)) return null;

    // Keep the most recent half of messages, compact the older half
    const splitPoint = Math.floor(messages.length / 2);
    const toCompact = messages.slice(0, splitPoint);
    const toKeep = messages.slice(splitPoint);

    // Extract facts before compacting
    await this.autoExtract(toCompact);

    // Summarize
    const compactionPrompt = buildCompactionPrompt(toCompact);
    let newSummary = await this.llmClient.text(compactionPrompt, { model: this.model() });

    // Merge with existing summary if present
    if (this.summary) {
      const mergePrompt = buildMergeSummaryPrompt(this.summary.summary, newSummary);
      newSummary = await this.llmClient.text(mergePrompt, { model: this.model() });
    }

    this.summary = {
      summary: newSummary,
      lastCompactedAt: new Date().toISOString(),
      messagesSummarized: (this.summary?.messagesSummarized ?? 0) + toCompact.length,
    };

    // Return new message array: summary as system message + kept messages
    const summaryMessage: Message = { role: "system", content: `Previous conversation summary:\n${newSummary}` };
    return [summaryMessage, ...toKeep];
  }

  async save(): Promise<void> {
    if (!this.initialized) return;
    await this.store.saveGraph(this.memoryId, this.graph.toJSON());
    await this.store.saveEmbeddings(this.memoryId, this.embeddings.toIndex());
    if (this.summary) {
      await this.store.saveSummary(this.memoryId, this.summary);
    }
  }

  private async autoExtract(messages: Message[]): Promise<void> {
    const prompt = buildExtractionPrompt(messages, this.graph);
    const response = await this.llmClient.text(prompt, { model: this.model() });
    let result: ExtractionResult;
    try {
      result = JSON.parse(response);
    } catch {
      return;
    }
    const newObsIds = applyExtractionResult(this.graph, result, this.source);
    await this.generateEmbeddings(newObsIds);
  }

  private async generateEmbeddings(observationIds: string[]): Promise<void> {
    if (!this.llmClient.embed) return;
    for (const obsId of observationIds) {
      // Find the observation content
      for (const entity of this.graph.getEntities()) {
        const obs = entity.observations.find((o) => o.id === obsId);
        if (obs) {
          try {
            const vector = await this.llmClient.embed(obs.content, {
              model: this.config.embeddings?.model,
            });
            this.embeddings.addEntry(obsId, vector);
          } catch {
            // Embedding failed (no API key, network error, etc.) — skip silently
          }
          break;
        }
      }
    }
  }

  private async embeddingRecall(query: string): Promise<string> {
    if (!this.llmClient.embed) return "";
    let queryVector: number[];
    try {
      queryVector = await this.llmClient.embed(query, {
        model: this.config.embeddings?.model,
      });
    } catch {
      return "";
    }
    const similar = this.embeddings.findSimilar(queryVector, 10, 0.3);
    if (similar.length === 0) return "";

    // Map observation IDs back to entities
    const entityIds: string[] = [];
    for (const result of similar) {
      for (const entity of this.graph.getEntities()) {
        if (entity.observations.some((o) => o.id === result.id)) {
          if (!entityIds.includes(entity.id)) entityIds.push(entity.id);
          break;
        }
      }
    }
    const entities = entityIds
      .map((id) => this.graph.getEntity(id))
      .filter((e): e is NonNullable<typeof e> => e !== null);
    return formatRetrievalResults(this.graph, entities);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test:run lib/runtime/memory/manager.test.ts 2>&1 | tee /tmp/manager-test-2.log`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/memory/manager.ts lib/runtime/memory/manager.test.ts
git commit -m "Add MemoryManager orchestrator for memory subsystems"
```

---

## Task 9: Config Integration

**Files:**
- Modify: `lib/config.ts`

- [ ] **Step 1: Read the current config file**

Read `lib/config.ts` to understand the exact Zod schema and interface structure.

- [ ] **Step 2: Add memory config to AgencyConfig interface**

Add the `memory` field to the `AgencyConfig` interface (around line 28-152 in `lib/config.ts`):

```typescript
memory?: {
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
```

- [ ] **Step 3: Add Zod schema validation**

Add the corresponding Zod schema (around line 156-204 in `lib/config.ts`):

```typescript
memory: z.object({
  dir: z.string(),
  model: z.string().optional(),
  autoExtract: z.object({
    interval: z.number().optional(),
  }).optional(),
  compaction: z.object({
    trigger: z.enum(["token", "messages"]).optional(),
    threshold: z.number().optional(),
  }).optional(),
  embeddings: z.object({
    model: z.string().optional(),
  }).optional(),
}).optional(),
```

- [ ] **Step 4: Run existing config tests to verify nothing broke**

Run: `pnpm test:run lib/config 2>&1 | tee /tmp/config-test.log`
Expected: All existing tests PASS

- [ ] **Step 5: Commit**

```bash
git add lib/config.ts
git commit -m "Add memory configuration to agency.json schema"
```

---

## Task 10: LLM `memory` Option in Typechecker

**Files:**
- Modify: `lib/typeChecker/builtins.ts`

- [ ] **Step 1: Read the current builtins file**

Read `lib/typeChecker/builtins.ts` to see the exact `llmOptions` definition (lines 26-60).

- [ ] **Step 2: Add `memory` to llmOptions**

Add the `memory` property to the `llmOptions` object. It accepts either `boolean` or an object with optional `model` field:

```typescript
{
  key: "memory",
  value: optional(
    unionType([
      boolean,
      objectType([{ key: "model", value: optional(string) }])
    ])
  ),
}
```

Note: Check the exact helper functions used in the file for creating union types and object types. The pattern should match the existing `thinking` option which also accepts an object.

- [ ] **Step 3: Run typechecker tests to verify nothing broke**

Run: `pnpm test:run lib/typeChecker 2>&1 | tee /tmp/tc-test.log`
Expected: All existing tests PASS

- [ ] **Step 4: Commit**

```bash
git add lib/typeChecker/builtins.ts
git commit -m "Add memory option to llm() typechecker definitions"
```

---

## Task 11: Runtime Integration — Memory in LLM Calls and Node Setup

**Files:**
- Modify: `lib/runtime/prompt.ts` — hook memory retrieval into `_runPrompt()`
- Modify: `lib/runtime/node.ts` — initialize MemoryManager in `setupNode()`
- Modify: `lib/runtime/context.ts` — add `memoryManager` to RuntimeContext

- [ ] **Step 1: Read the current files**

Read `lib/runtime/context.ts`, `lib/runtime/node.ts`, and `lib/runtime/prompt.ts` to understand the exact structures.

- [ ] **Step 2: Add memoryManager to RuntimeContext**

In `lib/runtime/context.ts`, add an optional `memoryManager` field to the RuntimeContext type:

```typescript
import type { MemoryManager } from "./memory/manager.js";
// ...
memoryManager?: MemoryManager;
```

- [ ] **Step 3: Initialize MemoryManager in setupNode()**

In `lib/runtime/node.ts`, inside `setupNode()`, check if the config has a `memory` section and if so, create a MemoryManager:

```typescript
import { MemoryManager } from "./memory/manager.js";
import { FileMemoryStore } from "./memory/store.js";

// Inside setupNode(), after other initialization:
if (config.memory) {
  const store = new FileMemoryStore(config.memory.dir);
  ctx.memoryManager = new MemoryManager({
    store,
    config: config.memory,
    llmClient: /* adapt the existing llmClient to the LlmClient interface */,
    source: moduleId,
  });
}
```

The exact integration will depend on the current shape of the LLM client. The `LlmClient` interface in `manager.ts` needs a `text()` method and optional `embed()` method. Adapt the existing smoltalk client to match.

- [ ] **Step 4: Hook memory recall into _runPrompt()**

In `lib/runtime/prompt.ts`, before the LLM call, check if the `memory` option is set in the client config. If so, call `memoryManager.recallForInjection()` and prepend the results as a system message:

```typescript
// Inside _runPrompt(), before making the LLM call:
if (clientConfig.memory && ctx.memoryManager) {
  const query = /* extract the user's latest message */;
  const facts = await ctx.memoryManager.recallForInjection(query);
  if (facts) {
    messages.unshift({ role: "system", content: `Relevant context from memory:\n${facts}` });
  }
}
```

Also, after each LLM call completes, call `memoryManager.onTurn()` to track turns for auto-extraction:

```typescript
// After LLM call completes:
if (ctx.memoryManager) {
  await ctx.memoryManager.onTurn(messages);
  const compacted = await ctx.memoryManager.compactIfNeeded(messages);
  if (compacted) {
    thread.setMessages(compacted);
  }
}
```

- [ ] **Step 5: Save memory on agent completion**

In `lib/runtime/node.ts`, in `runNode()` or the node teardown path, call `memoryManager.save()`:

```typescript
// After node execution completes:
if (ctx.memoryManager) {
  await ctx.memoryManager.save();
}
```

- [ ] **Step 6: Run existing tests to verify nothing broke**

Run: `pnpm test:run 2>&1 | tee /tmp/runtime-test.log`
Expected: All existing tests PASS (memory is only active when configured)

- [ ] **Step 7: Commit**

```bash
git add lib/runtime/context.ts lib/runtime/node.ts lib/runtime/prompt.ts
git commit -m "Integrate MemoryManager into runtime context and LLM pipeline"
```

---

## Task 12: std::memory Module

**Files:**
- Create: `lib/stdlib/memory.ts` — TypeScript implementation
- Create: `stdlib/memory.agency` — Agency wrapper

- [ ] **Step 1: Read existing stdlib patterns**

Read `lib/stdlib/wikipedia.ts` and `stdlib/wikipedia.agency` to confirm the exact pattern for TypeScript-to-Agency stdlib mapping.

- [ ] **Step 2: Implement TypeScript stdlib functions**

```typescript
// lib/stdlib/memory.ts

// These functions access the MemoryManager from the runtime context.
// The runtime context is passed through the __ctx parameter in compiled code.

export async function _setMemoryId(ctx: any, id: string): Promise<void> {
  if (!ctx.memoryManager) return;
  ctx.memoryManager.setMemoryId(id);
}

export async function _remember(ctx: any, content: string): Promise<void> {
  if (!ctx.memoryManager) return;
  await ctx.memoryManager.remember(content);
}

export async function _recall(ctx: any, query: string): Promise<string> {
  if (!ctx.memoryManager) return "";
  return ctx.memoryManager.recall(query);
}

export async function _forget(ctx: any, query: string): Promise<void> {
  if (!ctx.memoryManager) return;
  await ctx.memoryManager.forget(query);
}
```

Note: The exact way to access the runtime context from stdlib functions may differ from this. Check how other stdlib modules (like `builtins.ts` with `_print`, `_input`) access runtime state. The pattern might involve a global context reference or a parameter passed from the compiled code. Adapt accordingly.

- [ ] **Step 3: Create Agency wrapper**

```
// stdlib/memory.agency
import { _setMemoryId, _remember, _recall, _forget } from "agency-lang/stdlib-lib/memory.js"

/**
Set the memory scope for this agent run. Call this before other memory operations.
If not called, defaults to "default".
@param id - A unique identifier for the memory scope (e.g. user ID)
*/
export def setMemoryId(id: string) {
  _setMemoryId(id)
}

/**
Extract and store structured facts from the given text into the knowledge graph.
Uses LLM-powered extraction to identify entities, observations, and relations.
@param content - Natural language text containing facts to remember
*/
export def remember(content: string) {
  _remember(content)
}

/**
Retrieve relevant facts from the knowledge graph.
Uses structured lookup, embedding similarity, and LLM-powered retrieval.
@param query - A natural language query describing what to recall
*/
export safe def recall(query: string): string {
  return _recall(query)
}

/**
Expire facts matching the query from the knowledge graph.
Does not delete data — marks matching observations as no longer current.
@param query - A natural language description of what to forget
*/
export def forget(query: string) {
  _forget(query)
}
```

- [ ] **Step 4: Build stdlib**

Run: `make` (as per CLAUDE.md, always use `make` when changing stdlib files)

- [ ] **Step 5: Commit**

```bash
git add lib/stdlib/memory.ts stdlib/memory.agency
git commit -m "Add std::memory stdlib module"
```

---

## Task 13: Update index.ts exports

**Files:**
- Modify: `lib/runtime/memory/index.ts`

- [ ] **Step 1: Update the index to export all public APIs**

Now that all files exist, update the index:

```typescript
// lib/runtime/memory/index.ts
export * from "./types.js";
export { MemoryGraph } from "./graph.js";
export { FileMemoryStore } from "./store.js";
export { EmbeddingManager, cosineSimilarity } from "./embeddings.js";
export { MemoryManager } from "./manager.js";
export type { LlmClient, MemoryManagerOptions } from "./manager.js";
```

- [ ] **Step 2: Run full build**

Run: `make`

- [ ] **Step 3: Commit**

```bash
git add lib/runtime/memory/index.ts
git commit -m "Export all memory module public APIs"
```

---

## Task 14: Agency Execution Tests

**Files:**
- Create: `tests/agency/memory/` — directory for memory execution tests

These tests verify the full pipeline works end-to-end from Agency code. They use Agency's execution test framework and do NOT require real LLM calls (use a mock/deterministic LLM client).

- [ ] **Step 1: Read existing agency execution test patterns**

Read 2-3 tests in `tests/agency/` to understand the exact structure: file naming, how to set up a test, how to run it, how results are verified.

Also read `docs/misc/TESTING.md` for the full testing guide.

- [ ] **Step 2: Write a basic memory test**

Create a test that:
1. Configures memory in agency.json
2. Calls `setMemoryId("test-user")`
3. Calls `remember("Mom likes pottery")`
4. Calls `recall("what does mom like?")`
5. Verifies the result contains "pottery"

The exact test structure depends on the patterns found in step 1. Follow those patterns exactly.

- [ ] **Step 3: Write a test for memory: true on llm()**

Create a test that verifies the `memory: true` option on `llm()` causes facts to be injected.

- [ ] **Step 4: Run the tests**

Run: `pnpm run a test tests/agency/memory/<test-file> 2>&1 | tee /tmp/agency-memory-test.log`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/agency/memory/
git commit -m "Add agency execution tests for memory layer"
```

---

## Task 15: Final Integration Test and Cleanup

- [ ] **Step 1: Run the full test suite**

Run: `pnpm test:run 2>&1 | tee /tmp/full-test.log`
Expected: All PASS

- [ ] **Step 2: Run the structural linter**

Run: `pnpm run lint:structure 2>&1 | tee /tmp/lint.log`
Expected: PASS

- [ ] **Step 3: Build everything**

Run: `make 2>&1 | tee /tmp/build.log`
Expected: Clean build

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "Memory layer: final integration and cleanup"
```
