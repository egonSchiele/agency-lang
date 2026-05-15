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
      entities: [
        {
          id: "entity-1",
          name: "Mom",
          type: "person",
          source: "test",
          createdAt: "2026-01-01",
          observations: [],
        },
      ],
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
    const summary = {
      summary: "User discussed gifts",
      lastCompactedAt: "2026-01-01",
      messagesSummarized: 10,
    };
    await store.saveSummary("user-1", summary);
    const loaded = await store.loadSummary("user-1");
    expect(loaded).toEqual(summary);
  });

  it("returns null embeddings for new memoryId", async () => {
    const embeddings = await store.loadEmbeddings("user-1");
    expect(embeddings).toBeNull();
  });

  it("saves and loads embeddings", async () => {
    const index = {
      model: "text-embedding-3-small",
      entries: [{ id: "obs-1", vector: [0.1, 0.2, 0.3] }],
    };
    await store.saveEmbeddings("user-1", index);
    const loaded = await store.loadEmbeddings("user-1");
    expect(loaded).toEqual(index);
  });

  it("isolates different memoryIds", async () => {
    const data1 = {
      entities: [
        {
          id: "e-1",
          name: "Mom",
          type: "person",
          source: "test",
          createdAt: "2026-01-01",
          observations: [],
        },
      ],
      relations: [],
      nextId: 2,
    };
    const data2 = {
      entities: [
        {
          id: "e-1",
          name: "Dad",
          type: "person",
          source: "test",
          createdAt: "2026-01-01",
          observations: [],
        },
      ],
      relations: [],
      nextId: 2,
    };
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
