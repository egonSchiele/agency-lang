import { describe, it, expect } from "vitest";
import { typecheckSource } from "./testUtils.js";

const notATool = (src: string): string[] =>
  typecheckSource(src)
    .filter((e) => e.code === "AG6040")
    .map((e) => e.message);

const HEAD = `def search(q: string): string { return q }\ndef summary(q: string): string { return q }`;

describe("a plain value in an llm() tools list (issue #769)", () => {
  it("a local that shadows a function, used in its own initializer", () => {
    const errs = notATool(`${HEAD}
node main(query: string) {
  const summary: string = llm("find \${query}", tools: [search, summary])
  return summary
}`);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("'summary' is passed as a tool");
    expect(errs[0]).toContain("hides the function 'summary'");
  });

  it("the options-object form is checked too", () => {
    const errs = notATool(`${HEAD}
node main() {
  const label = "x"
  const r: string = llm("go", { tools: [search, label] })
}`);
    expect(errs).toHaveLength(1);
    expect(errs[0]).not.toContain("hides the function");
  });

  it("functions, partials and untyped values are left alone", () => {
    const errs = notATool(`${HEAD}
node main(extra: any) {
  const picked = [search]
  const r: string = llm("go", tools: [search, summary.describe("s"), extra])
  const r2: string = llm("go", tools: picked)
}`);
    expect(errs).toEqual([]);
  });
});
