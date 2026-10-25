import { expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { _prepareFunctions } from "./agencyFunctions.js";
import { safeDeleteDirectoryWithin } from "../utils.js";

it("describes original re-export metadata with markers from the callable wrapper", () => {
  const dir = fs.mkdtempSync(path.join(process.cwd(), ".learned-metadata-"));
  try {
    fs.writeFileSync(
      path.join(dir, "original.agency"),
      'export def original(value: number = 17): number { """Read the original value.""" return value }',
    );
    fs.writeFileSync(
      path.join(dir, "index.agency"),
      'export { destructive original as renamed } from "./original.agency"',
    );
    const { compiled } = _prepareFunctions(
      { kind: "file", dir, filename: "index.agency" },
      ["renamed"],
      true,
    );
    const entryPath = compiled.entryPath ?? `${compiled.moduleId}.js`;
    for (const [filename, code] of Object.entries({
      ...compiled.modules,
      [entryPath]: compiled.code,
    })) {
      const target = path.join(dir, "compiled", filename);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, code);
    }
    const runner = path.join(dir, "execute.mjs");
    fs.writeFileSync(
      runner,
      `import { describeLearned } from ${JSON.stringify(`./compiled/${entryPath}`)};
const result = await describeLearned();
process.stdout.write(JSON.stringify(result.data));`,
    );
    const definitions = JSON.parse(execFileSync(process.execPath, [runner], { encoding: "utf8" }));
    expect(definitions[0]).toMatchObject({
      name: "renamed",
      description: "Read the original value.",
      markers: { destructive: true },
      params: [{ hasDefault: true }],
    });
  } finally {
    expect(safeDeleteDirectoryWithin(process.cwd(), dir).success).toBe(true);
  }
});
