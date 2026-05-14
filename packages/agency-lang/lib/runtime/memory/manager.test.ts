import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MemoryManager } from "./manager.js";
import { FileMemoryStore } from "./store.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function mockLlmClient() {
  return {
    text: vi.fn().mockResolvedValue(
      JSON.stringify({
        entities: [],
        relations: [],
        expirations: [],
      })
    ),
    embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
  };
}

describe("MemoryManager", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-mgr-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("defaults to 'default' memoryId", () => {
    const store = new FileMemoryStore(tmpDir);
    const manager = new MemoryManager({
      store,
      config: { dir: tmpDir },
      llmClient: mockLlmClient(),
    });
    expect(manager.getMemoryId()).toBe("default");
  });

  it("sets memoryId", () => {
    const store = new FileMemoryStore(tmpDir);
    const manager = new MemoryManager({
      store,
      config: { dir: tmpDir },
      llmClient: mockLlmClient(),
    });
    manager.setMemoryId("user-123");
    expect(manager.getMemoryId()).toBe("user-123");
  });

  it("lazily initializes on first operation", async () => {
    const store = new FileMemoryStore(tmpDir);
    const manager = new MemoryManager({
      store,
      config: { dir: tmpDir },
      llmClient: mockLlmClient(),
    });
    expect(manager.isInitialized()).toBe(false);
    await manager.remember("Mom likes pottery");
    expect(manager.isInitialized()).toBe(true);
  });

  it("persists graph on save", async () => {
    const store = new FileMemoryStore(tmpDir);
    const client = mockLlmClient();
    client.text.mockResolvedValue(
      JSON.stringify({
        entities: [
          { name: "Mom", type: "person", observations: ["Likes pottery"] },
        ],
        relations: [],
        expirations: [],
      })
    );
    const manager = new MemoryManager({
      store,
      config: { dir: tmpDir },
      llmClient: client,
    });
    await manager.remember("Mom likes pottery");
    await manager.save();

    const manager2 = new MemoryManager({
      store,
      config: { dir: tmpDir },
      llmClient: mockLlmClient(),
    });
    await manager2.init();
    const entities = manager2.getGraph().getEntities();
    expect(entities).toHaveLength(1);
    expect(entities[0].name).toBe("Mom");
  });

  it("caches per memoryId — switching id keeps both in memory", async () => {
    const store = new FileMemoryStore(tmpDir);
    const client = mockLlmClient();
    client.text.mockImplementation(async (prompt: string) => {
      if (prompt.includes("Alice")) {
        return JSON.stringify({
          entities: [{ name: "Alice", type: "person", observations: ["a fact"] }],
          relations: [],
          expirations: [],
        });
      }
      if (prompt.includes("Bob")) {
        return JSON.stringify({
          entities: [{ name: "Bob", type: "person", observations: ["b fact"] }],
          relations: [],
          expirations: [],
        });
      }
      return JSON.stringify({ entities: [], relations: [], expirations: [] });
    });
    const manager = new MemoryManager({
      store,
      config: { dir: tmpDir },
      llmClient: client,
    });
    manager.setMemoryId("user-a");
    await manager.remember("Alice info");
    manager.setMemoryId("user-b");
    await manager.remember("Bob info");
    // Switch back
    manager.setMemoryId("user-a");
    expect(manager.getGraph().getEntities()[0].name).toBe("Alice");
    manager.setMemoryId("user-b");
    expect(manager.getGraph().getEntities()[0].name).toBe("Bob");
  });

  it("persists on every write (remember auto-saves)", async () => {
    const store = new FileMemoryStore(tmpDir);
    const client = mockLlmClient();
    client.text.mockResolvedValue(
      JSON.stringify({
        entities: [
          { name: "Mom", type: "person", observations: ["Likes pottery"] },
        ],
        relations: [],
        expirations: [],
      })
    );
    const manager = new MemoryManager({
      store,
      config: { dir: tmpDir },
      llmClient: client,
    });
    await manager.remember("Mom likes pottery");
    // Without explicit save, a fresh manager should still see the data.
    const fresh = new MemoryManager({
      store,
      config: { dir: tmpDir },
      llmClient: mockLlmClient(),
    });
    await fresh.init();
    expect(fresh.getGraph().getEntities()).toHaveLength(1);
  });

  it("recall returns union of tiers (structured + embeddings) up to K", async () => {
    const store = new FileMemoryStore(tmpDir);
    const client = mockLlmClient();
    // First call: extraction populates Mom + observation.
    client.text.mockResolvedValueOnce(
      JSON.stringify({
        entities: [
          { name: "Mom", type: "person", observations: ["Likes pottery"] },
        ],
        relations: [],
        expirations: [],
      })
    );
    const manager = new MemoryManager({
      store,
      config: { dir: tmpDir },
      llmClient: client,
    });
    await manager.remember("Mom likes pottery");
    // Tier 3 LLM call returns an empty list — but tier 1 should still match.
    client.text.mockResolvedValue("[]");
    const text = await manager.recall("mom");
    expect(text).toContain("Mom");
    expect(text).toContain("Likes pottery");
  });

  it("forget uses substring matching (soft-delete via validTo)", async () => {
    const store = new FileMemoryStore(tmpDir);
    const client = mockLlmClient();
    client.text.mockResolvedValueOnce(
      JSON.stringify({
        entities: [
          {
            name: "Mom",
            type: "person",
            observations: ["Favorite color is blue"],
          },
        ],
        relations: [],
        expirations: [],
      })
    );
    const manager = new MemoryManager({
      store,
      config: { dir: tmpDir },
      llmClient: client,
    });
    await manager.remember("Mom's favorite color is blue");
    // forget asks the LLM what to expire — return a substring that should match.
    client.text.mockResolvedValueOnce(
      JSON.stringify({
        observations: [
          { entityName: "Mom", observationContent: "favorite color" },
        ],
        relations: [],
      })
    );
    await manager.forget("forget mom's favorite color");
    const mom = manager.getGraph().findEntityByName("Mom")!;
    const current = manager.getGraph().getCurrentObservations(mom.id);
    expect(current).toHaveLength(0);
    // Original observation still present, just expired
    expect(mom.observations[0].validTo).toBeTruthy();
  });
});
