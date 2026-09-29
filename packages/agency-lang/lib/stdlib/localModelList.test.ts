import { describe, it, expect } from "vitest";
import { formatLocalList } from "./localModelList.js";
import type { DownloadedModel, ModelNameEntry } from "./localModels.js";

describe("formatLocalList kinds", () => {
  const entries: ModelNameEntry[] = [
    {
      name: "painter",
      backend: "diffusers",
      target: "diffusers:org/painter",
      source: "curated",
      kind: "image",
    },
    {
      name: "embedder",
      backend: "mlx",
      target: "mlx:org/embedder",
      source: "curated",
      kind: "embedding",
    },
    // A plain alias: no kind, so only its files can say what it is.
    { name: "my-alias", backend: "mlx", target: "mlx:org/aliased", source: "alias" },
    {
      name: "coder",
      backend: "mlx",
      target: "mlx:org/coder",
      source: "curated",
      kind: "chat",
      tags: ["coding"],
    },
    // A plain alias whose files are not downloaded: nothing says its kind.
    { name: "not-here", backend: "mlx", target: "mlx:org/missing", source: "alias" },
  ];
  const files: DownloadedModel[] = [
    {
      name: "org/aliased",
      path: "/d/mlx/org--aliased",
      sizeBytes: 1e9,
      backend: "mlx",
      complete: true,
      layout: "agency",
      kind: "chat",
    },
    {
      name: "org/stray-tts",
      path: "/d/mlx/org--stray-tts",
      sizeBytes: 1e9,
      backend: "mlx",
      complete: true,
      layout: "agency",
      kind: "speech",
    },
  ];

  /** The table rows' first cell after the mark: each model's name. */
  function names(out: string): string[] {
    const table = out.split("\n\n")[1].split("\n").slice(1);
    return table.map((line) => line.trim().replace(/^✓\s+/, "").split(/\s+/)[0]);
  }

  it("shows a KIND column, from the entry or else from the files", () => {
    const out = formatLocalList({ dir: "/d", entries, manifest: {}, files });
    const lines = out.split("\n");
    expect(lines[2]).toMatch(/NAME\s+KIND\s+BACKEND/);
    expect(lines.find((l) => l.includes("coder"))).toMatch(/coder\s+chat\s+mlx/);
    expect(lines.find((l) => l.includes("my-alias"))).toMatch(/my-alias\s+chat\s+mlx/);
    expect(lines.find((l) => l.includes("painter"))).toMatch(/painter\s+image\s+diffusers/);
  });

  it("orders rows by kind, chat first, and a row of no kind last", () => {
    const out = formatLocalList({ dir: "/d", entries, manifest: {}, files });
    expect(names(out)).toEqual(["my-alias", "coder", "embedder", "painter", "not-here"]);
  });

  it("with --kind, keeps only that kind, in the table and under OTHER FILES", () => {
    const chat = formatLocalList({ dir: "/d", entries, manifest: {}, files, kind: "chat" });
    expect(names(chat)).toEqual(["my-alias", "coder"]);
    expect(chat).not.toContain("OTHER FILES");
    const speech = formatLocalList({ dir: "/d", entries, manifest: {}, files, kind: "speech" });
    expect(names(speech)).toEqual([]);
    expect(speech).toContain("OTHER FILES\n  org/stray-tts");
  });
});
