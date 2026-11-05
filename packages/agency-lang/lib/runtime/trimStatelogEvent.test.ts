import { describe, expect, it } from "vitest";
import { capString, trimEventData, trimField, TRUNCATED_KEY } from "./trimStatelogEvent.js";

describe("capString", () => {
  it("leaves a string at the cap alone", () => {
    expect(capString("abc", 3, () => {})).toBe("abc");
  });

  it("cuts a longer string to fit the cap, marker included, and says how many went", () => {
    let cuts = 0;
    const text = capString("abcdefghij".repeat(10), 50, () => {
      cuts += 1;
    });
    expect(text.length).toBeLessThanOrEqual(50);
    expect(text).toBe(`${"abcdefghij".repeat(10).slice(0, 28)}…[truncated 72 chars]`);
    expect(cuts).toBe(1);
  });

  it("keeps a short string the marker would make longer", () => {
    let cuts = 0;
    const text = capString("row 2683", 3, () => {
      cuts += 1;
    });
    expect(text).toBe("row 2683");
    expect(cuts).toBe(0);
  });

  it("never cuts with a cap of 0", () => {
    expect(capString("x".repeat(500_000), 0, () => {}).length).toBe(500_000);
  });
});

describe("trimField", () => {
  it("returns a value under the budget unchanged", () => {
    const value = { name: "Mumbai", tags: ["a", "b"], count: 3 };
    expect(trimField(value, 1000)).toEqual({ value, cut: false });
  });

  it("keeps a prefix of an array and ends it with a marker item", () => {
    const items = Array.from({ length: 100 }, (_unused, index) => `item-${index}`);
    const { value, cut } = trimField(items, 100);
    const kept = value as string[];
    expect(cut).toBe(true);
    expect(kept.slice(0, -1)).toEqual(items.slice(0, kept.length - 1));
    expect(kept.at(-1)).toBe(`[truncated: ${100 - (kept.length - 1)} more items]`);
  });

  it("keeps an object's first keys and adds __truncated for the rest", () => {
    const record = Object.fromEntries(
      Array.from({ length: 50 }, (_unused, index) => [`key${index}`, index]),
    );
    const { value, cut } = trimField(record, 60);
    const kept = value as Record<string, unknown>;
    const keys = Object.keys(kept).filter((key) => key !== TRUNCATED_KEY);
    expect(cut).toBe(true);
    expect(keys).toEqual(Object.keys(record).slice(0, keys.length));
    expect(kept[TRUNCATED_KEY]).toBe(`${50 - keys.length} more keys`);
  });

  it("cuts a nested value where the budget runs out and keeps what came before whole", () => {
    const value = { first: { name: "kept whole" }, second: Array.from({ length: 100 }, () => 7) };
    const trimmed = trimField(value, 80).value as { first: unknown; second: unknown[] };
    expect(trimmed.first).toEqual({ name: "kept whole" });
    expect(trimmed.second.length).toBeLessThan(100);
    expect(trimmed.second.at(-1)).toMatch(/^\[truncated: \d+ more items\]$/);
  });

  it("cuts a long string field to the budget", () => {
    const { value, cut } = trimField("s".repeat(5000), 100);
    expect(cut).toBe(true);
    expect(value).toBe(`${"s".repeat(76)}…[truncated 4,924 chars]`);
  });

  it("keeps an array of small numbers within the budget plus one item", () => {
    const digits = Array.from({ length: 10_000 }, (_unused, index) => index % 10);
    const trimmed = trimField(digits, 1000).value as unknown[];
    const marker = JSON.stringify(trimmed.at(-1));
    expect(JSON.stringify(trimmed).length).toBeLessThanOrEqual(1000 + marker.length + 1);
  });
});

describe("trimEventData", () => {
  const rows = Array.from({ length: 200 }, (_unused, index) => ({ index }));

  it("gives each field its own budget", () => {
    const { data, cut } = trimEventData({ type: "toolCall", args: rows, output: rows }, 200);
    const args = data.args as unknown[];
    const output = data.output as unknown[];
    expect(cut).toBe(true);
    expect(args.length).toBe(output.length);
    expect(args.length).toBeGreaterThan(2);
  });

  it("leaves a promptCompletion's messages whole", () => {
    const { data, cut } = trimEventData({ type: "promptCompletion", messages: rows }, 200);
    expect(cut).toBe(false);
    expect(data.messages).toEqual(rows);
  });

  it("trims messages on any other event", () => {
    const { data, cut } = trimEventData({ type: "threadUpdated", messages: rows }, 200);
    expect(cut).toBe(true);
    expect((data.messages as unknown[]).length).toBeLessThan(200);
  });
});
