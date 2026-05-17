import { describe, it, expect } from "vitest";
import { ContentAddressableStore } from "./contentAddressableStore.js";

describe("ContentAddressableStore", () => {
  it("hashes each element of an array when key is marked true", () => {
    const store = new ContentAddressableStore();
    const schema = { frames: true } as const;
    const obj = { frames: [{ step: 0 }, { step: 1 }] };
    const { record, chunks } = store.process(obj, schema);

    expect(Array.isArray(record.frames)).toBe(true);
    expect(record.frames).toHaveLength(2);
    expect(typeof record.frames[0]).toBe("string");
    expect(typeof record.frames[1]).toBe("string");
    expect(record.frames[0]).toHaveLength(16);
    expect(chunks).toHaveLength(2);
  });

  it("hashes each value of an object when key is marked true", () => {
    const store = new ContentAddressableStore();
    const schema = { items: true } as const;
    const obj = { items: { a: { x: 1 }, b: { x: 2 } } };
    const { record, chunks } = store.process(obj, schema);

    expect(typeof record.items.a).toBe("string");
    expect(typeof record.items.b).toBe("string");
    expect(record.items.a).not.toBe(record.items.b);
    expect(chunks).toHaveLength(2);
  });

  it("hashes a primitive value when key is marked true", () => {
    const store = new ContentAddressableStore();
    const schema = { name: true } as const;
    const { record, chunks } = store.process({ name: "Alice", age: 30 }, schema);

    expect(typeof record.name).toBe("string");
    expect(record.name).toHaveLength(16);
    expect(record.age).toBe(30);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].data).toBe("Alice");
  });

  it("recurses into nested schema", () => {
    const store = new ContentAddressableStore();
    const schema = { outer: { inner: true } } as const;
    const { record } = store.process(
      { outer: { inner: [1, 2, 3], other: "hi" } },
      schema,
    );

    expect(Array.isArray(record.outer.inner)).toBe(true);
    expect(typeof record.outer.inner[0]).toBe("string");
    expect(record.outer.other).toBe("hi");
  });

  it("deduplicates identical values within one call", () => {
    const store = new ContentAddressableStore();
    const schema = { items: true } as const;
    const obj = { items: { a: { x: 1 }, b: { x: 1 } } };
    const { record, chunks } = store.process(obj, schema);

    expect(record.items.a).toBe(record.items.b);
    expect(chunks).toHaveLength(1);
  });

  it("deduplicates across multiple process calls", () => {
    const store = new ContentAddressableStore();
    const schema = { data: true } as const;

    const result1 = store.process({ data: { x: 1 } }, schema);
    const result2 = store.process({ data: { x: 1 } }, schema);

    expect(result1.chunks.length).toBeGreaterThan(0);
    expect(result2.chunks).toHaveLength(0);
  });

  it("returns non-schema keys unchanged", () => {
    const store = new ContentAddressableStore();
    const schema = { big: true } as const;
    const { record } = store.process({ big: [1, 2, 3], small: "hi", num: 42 }, schema);

    expect(record.small).toBe("hi");
    expect(record.num).toBe(42);
    expect(Array.isArray(record.big)).toBe(true);
    expect(typeof record.big[0]).toBe("string");
  });

  it("handles empty objects and arrays", () => {
    const store = new ContentAddressableStore();
    const schema = { items: true } as const;

    const { record: r1, chunks: c1 } = store.process({ items: {} }, schema);
    expect(r1.items).toEqual({});
    expect(c1).toHaveLength(0);

    const { record: r2, chunks: c2 } = store.process({ items: [] }, schema);
    expect(r2.items).toEqual([]);
    expect(c2).toHaveLength(0);
  });

  it("seedSeenHashes prevents re-emission of seeded hashes without populating chunkData", () => {
    // First, learn what hashes a value produces by running it through one store.
    const probe = new ContentAddressableStore();
    const schema = { items: true } as const;
    const { record: probedRecord, chunks: probedChunks } = probe.process(
      { items: { a: { x: 1 }, b: { x: 2 } } },
      schema,
    );
    const hashA = probedRecord.items.a as string;
    const hashB = probedRecord.items.b as string;
    expect(probedChunks).toHaveLength(2);

    // Now seed a fresh store with those hashes and confirm process() emits nothing.
    const fresh = new ContentAddressableStore();
    fresh.seedSeenHashes(new Set([hashA, hashB]));
    const { record, chunks } = fresh.process(
      { items: { a: { x: 1 }, b: { x: 2 } } },
      schema,
    );
    expect(record.items.a).toBe(hashA);
    expect(record.items.b).toBe(hashB);
    expect(chunks).toHaveLength(0);

    // A new value (hash not seeded) is still emitted.
    const { chunks: c2 } = fresh.process({ items: { c: { x: 3 } } }, schema);
    expect(c2).toHaveLength(1);
  });

  it("reconstruct reverses process", () => {
    const store = new ContentAddressableStore();
    const schema = { outer: { inner: true } } as const;
    const original = { outer: { inner: [{ a: 1 }, { a: 2 }], other: "hi" }, top: 99 };

    store.process(original, schema);
    const { record } = store.process(original, schema);

    const reconstructed = store.reconstruct(record, schema);
    expect(reconstructed).toEqual(original);
  });
});
