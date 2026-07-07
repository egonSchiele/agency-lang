import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";

import { discoverOptimizeTargets, type OptimizeTarget, type OptimizeTargetSet } from "./targets.js";
import {
  OptimizeSourceMutator,
  type OptimizeMutationOperation,
} from "./sourceMutator.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-source-mutator-"));
  tempDirs.push(dir);
  return dir;
}

function writeAgency(dir: string, relativePath: string, source: string): string {
  const file = path.join(dir, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
  return file;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const ENTRY_SOURCE = `import { helper } from "./helpers/prompts.agency"

optimize static const systemPrompt = "old"

def bar() {
  optimize const prompt = "xyz"
  const result = llm(prompt)
}
`;

const HELPER_SOURCE = `optimize const importedPrompt = "imported"

def helper() {
  return importedPrompt
}
`;

function discoverFixture(): OptimizeTargetSet {
  const dir = makeTempDir();
  const entry = writeAgency(dir, "foo.agency", ENTRY_SOURCE);
  writeAgency(dir, "helpers/prompts.agency", HELPER_SOURCE);
  return discoverOptimizeTargets(entry, { baseDir: dir });
}

const FOO_SOURCE = `optimize static const greeting = "hello \${name}"

def bar() {
  optimize const prompt = "xyz"
}
`;

function makeTargetSet(extraTargets: OptimizeTarget[] = []): OptimizeTargetSet {
  return {
    baseDir: "/abs",
    entryFile: "foo.agency",
    typeAliases: {},
    files: {
      "foo.agency": {
        file: "foo.agency",
        absoluteFile: "/abs/foo.agency",
        source: FOO_SOURCE,
        sha256: "ignored",
      },
    },
    targets: [
      {
        id: "foo.agency:bar:prompt",
        kind: "variable",
        file: "foo.agency",
        absoluteFile: "/abs/foo.agency",
        scope: "bar",
        name: "prompt",
        valueKind: "string",
        value: "xyz",
      },
      {
        id: "foo.agency:global:greeting",
        kind: "variable",
        file: "foo.agency",
        absoluteFile: "/abs/foo.agency",
        scope: "global",
        name: "greeting",
        valueKind: "string",
        value: "hello ${name}",
      },
      ...extraTargets,
    ],
  };
}

function previewDiagnostics(
  operations: OptimizeMutationOperation[],
  targetSet: OptimizeTargetSet = makeTargetSet(),
) {
  return new OptimizeSourceMutator({ targetSet }).preview(operations).diagnostics;
}

const validOperation: OptimizeMutationOperation = {
  target: "foo.agency:bar:prompt",
  kind: "variable",
  op: "replaceInitializer",
  value: "\"new prompt\"",
};

describe("OptimizeSourceMutator operation validation", () => {
  it("accepts a valid replaceInitializer operation", () => {
    expect(previewDiagnostics([validOperation])).toEqual([]);
  });

  it("accepts a matching expected value", () => {
    expect(previewDiagnostics([{ ...validOperation, expected: "xyz" }])).toEqual([]);
  });

  it("rejects unknown targets", () => {
    const diagnostics = previewDiagnostics([
      { ...validOperation, target: "foo.agency:bar:missing" },
    ]);
    expect(diagnostics).toMatchObject([
      { code: "unknown-target", target: "foo.agency:bar:missing" },
    ]);
  });

  it("rejects operations whose kind does not match the target", () => {
    // Future type targets are not discoverable in v1, so hand-construct one
    // to prove a variable operation aimed at it is a kind mismatch.
    const typeTarget = {
      id: "foo.agency:ResultType",
      kind: "type",
      file: "foo.agency",
      absoluteFile: "/abs/foo.agency",
      scope: "global",
      name: "ResultType",
      valueKind: "string",
      value: "string",
    } as unknown as OptimizeTarget;
    const diagnostics = previewDiagnostics(
      [{ ...validOperation, target: "foo.agency:ResultType" }],
      makeTargetSet([typeTarget]),
    );
    expect(diagnostics).toMatchObject([
      { code: "kind-mismatch", target: "foo.agency:ResultType" },
    ]);
  });

  it("rejects unsupported operations for the target kind", () => {
    const operation = {
      target: "foo.agency:bar:prompt",
      kind: "variable",
      op: "replaceTypeDefinition",
      value: "\"new prompt\"",
    } as unknown as OptimizeMutationOperation;
    expect(previewDiagnostics([operation])).toMatchObject([
      { code: "unsupported-operation", target: "foo.agency:bar:prompt" },
    ]);
  });

  it("rejects duplicate operations for the same target", () => {
    const diagnostics = previewDiagnostics([
      validOperation,
      { ...validOperation, value: "\"other prompt\"" },
    ]);
    expect(diagnostics).toMatchObject([
      { code: "duplicate-target-operation", target: "foo.agency:bar:prompt" },
    ]);
  });

  it("rejects stale expected values", () => {
    const diagnostics = previewDiagnostics([
      { ...validOperation, expected: "stale value" },
    ]);
    expect(diagnostics).toMatchObject([
      { code: "expected-mismatch", target: "foo.agency:bar:prompt" },
    ]);
    expect(diagnostics[0].message).toContain("xyz");
  });

  it("rejects reserved type operations in v1 with a clear diagnostic", () => {
    const diagnostics = previewDiagnostics([
      {
        target: "foo.agency:ResultType",
        kind: "type",
        op: "replaceTypeDefinition",
        value: "{ capital: string }",
      },
    ]);
    expect(diagnostics).toMatchObject([
      { code: "unsupported-operation", target: "foo.agency:ResultType" },
    ]);
    expect(diagnostics[0].message).toMatch(/v1/);
  });

  it("collects diagnostics for every invalid operation in the batch", () => {
    const diagnostics = previewDiagnostics([
      { ...validOperation, target: "foo.agency:bar:missing" },
      { ...validOperation, expected: "stale value" },
    ]);
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "unknown-target",
      "expected-mismatch",
    ]);
  });
});

describe("OptimizeSourceMutator replacement value validation", () => {
  it("accepts a replacement that preserves interpolations", () => {
    const diagnostics = previewDiagnostics([
      {
        target: "foo.agency:global:greeting",
        kind: "variable",
        op: "replaceInitializer",
        value: "\"welcome, ${name}!\"",
      },
    ]);
    expect(diagnostics).toEqual([]);
  });

  it("rejects a replacement that drops an interpolation", () => {
    const diagnostics = previewDiagnostics([
      {
        target: "foo.agency:global:greeting",
        kind: "variable",
        op: "replaceInitializer",
        value: "\"welcome!\"",
      },
    ]);
    expect(diagnostics).toMatchObject([
      { code: "interpolation-mismatch", target: "foo.agency:global:greeting" },
    ]);
  });

  it("rejects replacement values that are not valid Agency expressions", () => {
    const diagnostics = previewDiagnostics([
      { ...validOperation, value: "\"unterminated" },
    ]);
    expect(diagnostics).toMatchObject([
      { code: "invalid-replacement-syntax", target: "foo.agency:bar:prompt" },
    ]);
  });

  it("wraps unquoted prose into a string literal (recovers a model that omits quotes)", () => {
    const preview = new OptimizeSourceMutator({ targetSet: makeTargetSet() }).preview([
      { ...validOperation, value: "What is the capital of India?" },
    ]);
    expect(preview.diagnostics).toEqual([]);
    expect(preview.changes[0].newValue).toBe("What is the capital of India?");
  });

  it("wraps unquoted text even when it looks like code", () => {
    const preview = new OptimizeSourceMutator({ targetSet: makeTargetSet() }).preview([
      { ...validOperation, value: "x => x + 1" },
    ]);
    expect(preview.diagnostics).toEqual([]);
    expect(preview.changes[0].newValue).toBe("x => x + 1");
  });

  it("still rejects unquoted text with embedded quotes that cannot be wrapped cleanly", () => {
    const diagnostics = previewDiagnostics([
      { ...validOperation, value: 'Say "hi" to them' },
    ]);
    expect(diagnostics).toMatchObject([
      { code: "invalid-replacement-syntax", target: "foo.agency:bar:prompt" },
    ]);
  });

  it("rejects replacement values with trailing content after the expression", () => {
    const diagnostics = previewDiagnostics([
      { ...validOperation, value: "\"ok\" trailing" },
    ]);
    expect(diagnostics).toMatchObject([
      { code: "invalid-replacement-syntax", target: "foo.agency:bar:prompt" },
    ]);
  });

  it("rejects non-string expressions in v1", () => {
    const diagnostics = previewDiagnostics([{ ...validOperation, value: "42" }]);
    expect(diagnostics).toMatchObject([
      { code: "unsupported-value-domain", target: "foo.agency:bar:prompt" },
    ]);
  });

  it("accepts multiline string replacements", () => {
    const diagnostics = previewDiagnostics([
      { ...validOperation, value: "\"\"\"\n  a longer prompt\n  \"\"\"" },
    ]);
    expect(diagnostics).toEqual([]);
  });
});

describe("OptimizeSourceMutator.preview", () => {
  it("replaces a function-scoped initializer and keeps everything else", () => {
    const targetSet = discoverFixture();
    const mutator = new OptimizeSourceMutator({ targetSet });

    const preview = mutator.preview([
      {
        target: "foo.agency:bar:prompt",
        kind: "variable",
        op: "replaceInitializer",
        value: "\"new prompt\"",
        rationale: "clearer instruction",
      },
    ]);

    expect(preview.diagnostics).toEqual([]);
    expect(preview.files["foo.agency"]).toContain("optimize const prompt = \"new prompt\"");
    expect(preview.files["foo.agency"]).toContain("optimize static const systemPrompt = \"old\"");
    expect(preview.files["foo.agency"]).toContain("llm(prompt)");
    expect(preview.files["helpers/prompts.agency"]).toBe(HELPER_SOURCE);
    expect(preview.changes).toEqual([
      {
        target: "foo.agency:bar:prompt",
        kind: "variable",
        op: "replaceInitializer",
        oldValue: "xyz",
        newValue: "new prompt",
        rationale: "clearer instruction",
      },
    ]);
  });

  it("replaces a top-level static initializer preserving modifiers", () => {
    const targetSet = discoverFixture();
    const mutator = new OptimizeSourceMutator({ targetSet });

    const preview = mutator.preview([
      {
        target: "foo.agency:global:systemPrompt",
        kind: "variable",
        op: "replaceInitializer",
        value: "\"brand new\"",
      },
    ]);

    expect(preview.diagnostics).toEqual([]);
    expect(preview.files["foo.agency"]).toContain("optimize static const systemPrompt = \"brand new\"");
    expect(preview.files["foo.agency"]).toContain("optimize const prompt = \"xyz\"");
  });

  it("produces an uncolored human-readable diff naming the changed file", () => {
    const targetSet = discoverFixture();
    const mutator = new OptimizeSourceMutator({ targetSet });

    const preview = mutator.preview([
      {
        target: "foo.agency:bar:prompt",
        kind: "variable",
        op: "replaceInitializer",
        value: "\"new prompt\"",
      },
    ]);

    expect(preview.diff).toContain("foo.agency");
    expect(preview.diff).toContain("- ");
    expect(preview.diff).toContain("+ ");
    expect(preview.diff).toContain("new prompt");
    expect(preview.diff).not.toContain("");
  });

  it("returns an updated target set for the candidate file set", () => {
    const targetSet = discoverFixture();
    const mutator = new OptimizeSourceMutator({ targetSet });

    const preview = mutator.preview([
      {
        target: "foo.agency:bar:prompt",
        kind: "variable",
        op: "replaceInitializer",
        value: "\"new prompt\"",
      },
    ]);

    const updated = preview.targetSet;
    const changedTarget = updated.targets.find((target) => target.id === "foo.agency:bar:prompt");
    expect(changedTarget?.value).toBe("new prompt");
    expect(updated.files["foo.agency"].source).toBe(preview.files["foo.agency"]);
    expect(updated.files["foo.agency"].sha256).not.toBe(targetSet.files["foo.agency"].sha256);
    const unchangedTarget = updated.targets.find(
      (target) => target.id === "helpers/prompts.agency:global:importedPrompt",
    );
    expect(unchangedTarget?.value).toBe("imported");
    expect(updated.files["helpers/prompts.agency"]).toEqual(targetSet.files["helpers/prompts.agency"]);
    expect(updated.targets.map((target) => target.id)).toEqual(targetSet.targets.map((target) => target.id));
  });

  it("applies two operations on different targets in the same file", () => {
    const targetSet = discoverFixture();
    const mutator = new OptimizeSourceMutator({ targetSet });

    const preview = mutator.preview([
      {
        target: "foo.agency:bar:prompt",
        kind: "variable",
        op: "replaceInitializer",
        value: "\"new prompt\"",
      },
      {
        target: "foo.agency:global:systemPrompt",
        kind: "variable",
        op: "replaceInitializer",
        value: "\"new system\"",
      },
    ]);

    expect(preview.diagnostics).toEqual([]);
    expect(preview.files["foo.agency"]).toContain("optimize const prompt = \"new prompt\"");
    expect(preview.files["foo.agency"]).toContain("optimize static const systemPrompt = \"new system\"");
    expect(preview.changes).toHaveLength(2);
    expect(preview.targetSet.targets.map((target) => target.value).sort()).toEqual([
      "imported",
      "new prompt",
      "new system",
    ]);
  });

  it("replaces a multiline string target with a single-line string", () => {
    const dir = makeTempDir();
    const entry = writeAgency(dir, "multi.agency", "optimize const big = \"\"\"\nline one\nline two\n\"\"\"\n\nnode main() {\n  return big\n}\n");
    const targetSet = discoverOptimizeTargets(entry, { baseDir: dir });
    expect(targetSet.targets[0].valueKind).toBe("multilineString");
    const mutator = new OptimizeSourceMutator({ targetSet });

    const preview = mutator.preview([
      {
        target: "multi.agency:global:big",
        kind: "variable",
        op: "replaceInitializer",
        value: "\"now short\"",
      },
    ]);

    expect(preview.diagnostics).toEqual([]);
    expect(preview.files["multi.agency"]).toContain("optimize const big = \"now short\"");
    const updated = preview.targetSet.targets.find((target) => target.id === "multi.agency:global:big");
    expect(updated?.valueKind).toBe("string");
    expect(updated?.value).toBe("now short");
  });

  it("applies multiple operations across files atomically", () => {
    const targetSet = discoverFixture();
    const mutator = new OptimizeSourceMutator({ targetSet });

    const preview = mutator.preview([
      {
        target: "foo.agency:bar:prompt",
        kind: "variable",
        op: "replaceInitializer",
        value: "\"new prompt\"",
      },
      {
        target: "helpers/prompts.agency:global:importedPrompt",
        kind: "variable",
        op: "replaceInitializer",
        value: "\"refreshed\"",
      },
    ]);

    expect(preview.diagnostics).toEqual([]);
    expect(preview.files["foo.agency"]).toContain("\"new prompt\"");
    expect(preview.files["helpers/prompts.agency"]).toContain("optimize const importedPrompt = \"refreshed\"");
    expect(preview.changes).toHaveLength(2);
  });

  it("returns no files when any operation in the batch is invalid", () => {
    const targetSet = discoverFixture();
    const mutator = new OptimizeSourceMutator({ targetSet });

    const preview = mutator.preview([
      {
        target: "foo.agency:bar:prompt",
        kind: "variable",
        op: "replaceInitializer",
        value: "\"new prompt\"",
      },
      {
        target: "foo.agency:bar:missing",
        kind: "variable",
        op: "replaceInitializer",
        value: "\"whatever\"",
      },
    ]);

    expect(preview.diagnostics).toMatchObject([{ code: "unknown-target" }]);
    expect(preview.files).toEqual({});
    expect(preview.changes).toEqual([]);
    expect(preview.diff).toBe("");
    expect(preview.targetSet).toBe(targetSet);
  });

  it("never parses files the batch does not touch", () => {
    const targetSet = discoverFixture();
    const garbled: OptimizeTargetSet = {
      ...targetSet,
      files: {
        ...targetSet.files,
        "helpers/prompts.agency": {
          ...targetSet.files["helpers/prompts.agency"],
          source: "%%% not agency source %%%",
        },
      },
    };
    const mutator = new OptimizeSourceMutator({ targetSet: garbled });

    const preview = mutator.preview([
      {
        target: "foo.agency:bar:prompt",
        kind: "variable",
        op: "replaceInitializer",
        value: "\"new prompt\"",
      },
    ]);

    expect(preview.diagnostics).toEqual([]);
    expect(preview.files["helpers/prompts.agency"]).toBe("%%% not agency source %%%");
  });

  it("replaces a single-line string with a multiline string", () => {
    const targetSet = discoverFixture();
    const mutator = new OptimizeSourceMutator({ targetSet });

    const preview = mutator.preview([
      {
        target: "foo.agency:global:systemPrompt",
        kind: "variable",
        op: "replaceInitializer",
        value: "\"\"\"\nfirst line\nsecond line\n\"\"\"",
      },
    ]);

    expect(preview.diagnostics).toEqual([]);
    expect(preview.files["foo.agency"]).toContain("\"\"\"");
    expect(preview.files["foo.agency"]).toContain("first line");
    const changed = preview.targetSet.targets.find(
      (target) => target.id === "foo.agency:global:systemPrompt",
    );
    expect(changed?.valueKind).toBe("multilineString");
  });
});

describe("OptimizeSourceMutator.mutate", () => {
  it("infers replaceInitializer for variable targets", () => {
    const mutator = new OptimizeSourceMutator({ targetSet: discoverFixture() });

    const preview = mutator.mutate("foo.agency:bar:prompt", "\"new\"");

    expect(preview.diagnostics).toEqual([]);
    expect(preview.changes).toMatchObject([
      { target: "foo.agency:bar:prompt", op: "replaceInitializer", newValue: "new" },
    ]);
    expect(preview.files["foo.agency"]).toContain("optimize const prompt = \"new\"");
  });

  it("rejects unknown targets", () => {
    const mutator = new OptimizeSourceMutator({ targetSet: discoverFixture() });

    const preview = mutator.mutate("foo.agency:bar:missing", "\"new\"");

    expect(preview.diagnostics).toMatchObject([
      { code: "unknown-target", target: "foo.agency:bar:missing" },
    ]);
    expect(preview.files).toEqual({});
  });

  it("rejects target kinds without v1 support instead of guessing", () => {
    const typeTarget = {
      id: "foo.agency:ResultType",
      kind: "type",
      file: "foo.agency",
      absoluteFile: "/abs/foo.agency",
      scope: "global",
      name: "ResultType",
      valueKind: "string",
      value: "string",
    } as unknown as OptimizeTarget;
    const mutator = new OptimizeSourceMutator({ targetSet: makeTargetSet([typeTarget]) });

    const preview = mutator.mutate("foo.agency:ResultType", "{ capital: string }");

    expect(preview.diagnostics).toMatchObject([{ code: "unsupported-operation" }]);
  });
});

describe("OptimizeSourceMutator.apply", () => {
  it("writes the full candidate file set under a destination directory", () => {
    const mutator = new OptimizeSourceMutator({ targetSet: discoverFixture() });
    const preview = mutator.mutate("foo.agency:bar:prompt", "\"new prompt\"");
    const destination = path.join(makeTempDir(), "agent");

    mutator.apply(preview, destination);

    expect(fs.readFileSync(path.join(destination, "foo.agency"), "utf8")).toBe(preview.files["foo.agency"]);
    expect(fs.readFileSync(path.join(destination, "helpers/prompts.agency"), "utf8")).toBe(HELPER_SOURCE);
  });

  it("writes changed files back to their source paths when no destination is given", () => {
    const targetSet = discoverFixture();
    const mutator = new OptimizeSourceMutator({ targetSet });
    const preview = mutator.mutate("foo.agency:bar:prompt", "\"new prompt\"");
    const helperPath = targetSet.files["helpers/prompts.agency"].absoluteFile;
    const helperStatBefore = fs.statSync(helperPath);

    mutator.apply(preview);

    const entryPath = targetSet.files["foo.agency"].absoluteFile;
    expect(fs.readFileSync(entryPath, "utf8")).toBe(preview.files["foo.agency"]);
    expect(fs.readFileSync(helperPath, "utf8")).toBe(HELPER_SOURCE);
    expect(fs.statSync(helperPath).mtimeMs).toBe(helperStatBefore.mtimeMs);
  });

  it("refuses to apply a preview with diagnostics", () => {
    const mutator = new OptimizeSourceMutator({ targetSet: discoverFixture() });
    const preview = mutator.mutate("foo.agency:bar:missing", "\"new\"");
    const destination = path.join(makeTempDir(), "agent");

    expect(() => mutator.apply(preview, destination)).toThrow(/diagnostics/);
    expect(fs.existsSync(destination)).toBe(false);
  });
});
