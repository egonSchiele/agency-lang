import { describe, expect, it } from "vitest";
import { checkPolicyExplicit, type Policy } from "../../runtime/policy.js";
import { runPolicy, startRules, uncoveredEffects } from "./runPolicy.js";

const steps = [
  { step: "note", tool: "searchNotes", effects: [] },
  { step: "text", tool: "readNote", effects: ["std::read"] },
  { step: "again", tool: "readNote", effects: ["std::read"] },
  { step: "add", tool: "addListItems", effects: ["test::lists::add"] },
];

const start = startRules({
  name: "addOne",
  dir: "/p/proj",
  workflowsDir: "/real/p/proj/workflows",
  moduleReads: [{ dir: "/real/p/proj", filename: "tools/lists.agency" }],
});

const DIRS = { cwd: "/", agentHome: "/home/.agency-agent", home: "/home", agencyInstallDir: null };

const decide = (policy: Policy, effect: string, data: Record<string, unknown>) =>
  checkPolicyExplicit(policy, { effect, message: "", data, origin: "" }, DIRS);

describe("uncoveredEffects", () => {
  it("leaves out an effect the policy has any rule for, even a rule with a match", () => {
    const policy: Policy = { "std::read": [{ match: { dir: "/elsewhere" }, action: "approve" }] };
    expect(uncoveredEffects(steps, policy)).toEqual([
      { effect: "test::lists::add", steps: ["add (addListItems)"] },
    ]);
  });

  it("names every step that raises an effect", () => {
    expect(uncoveredEffects(steps, {})[0]).toEqual({
      effect: "std::read",
      steps: ["text (readNote)", "again (readNote)"],
    });
  });

  it("returns nothing for a policy with a * rule", () => {
    expect(uncoveredEffects(steps, { "*": [{ action: "reject" }] })).toEqual([]);
  });
});

describe("runPolicy", () => {
  it("puts the person's rules first, then the start rules", () => {
    const person: Policy = {
      "std::read": [{ match: { dir: "/safe/**" }, action: "approve" }, { action: "reject" }],
    };
    const policy = runPolicy(person, start, []);
    expect(policy["std::read"]).toEqual([...person["std::read"], ...start["std::read"]]);
  });

  it("gives an accepted effect one approve rule with no match, and rejects the rest", () => {
    const policy = runPolicy({}, start, ["test::lists::add"]);
    expect(policy["test::lists::add"]).toEqual([{ action: "approve" }]);
    expect(policy["*"]).toEqual([{ action: "reject" }]);
    expect(decide(policy, "std::write", { dir: "/p" })).toEqual({ type: "reject" });
  });

  it("returns a policy with its own * rule unchanged", () => {
    const person: Policy = { "*": [{ action: "approve" }] };
    expect(runPolicy(person, start, ["test::lists::add"])).toBe(person);
  });

  it("escapes glob characters in a directory, so it matches only itself", () => {
    const glob = startRules({ name: "addOne", dir: "/p/v*1", workflowsDir: "/w", moduleReads: [] });
    expect(decide(glob, "std::workflow::run", { name: "addOne", dir: "/p/v*1" })).toEqual({
      type: "approve",
    });
    expect(decide(glob, "std::workflow::run", { name: "addOne", dir: "/p/v21" })).toBeNull();
  });

  it("approves the scan of the workflows folder, and rejects a scan of any other", () => {
    const policy = runPolicy({}, start, []);
    expect(decide(policy, "std::workflow::scan", { dir: "/real/p/proj/workflows" })).toEqual({
      type: "approve",
    });
    expect(decide(policy, "std::workflow::scan", { dir: "/other/workflows" })).toEqual({
      type: "reject",
    });
  });

  it("approves the start prompts and the module read, and nothing else of those effects", () => {
    const policy = runPolicy({}, start, []);
    expect(decide(policy, "std::run", { node: "main", depth: 1 })).toEqual({ type: "approve" });
    expect(decide(policy, "std::run", { node: "main", depth: 2 })).toEqual({ type: "reject" });
    expect(
      decide(policy, "std::read", { dir: "/real/p/proj", filename: "tools/lists.agency" }),
    ).toEqual({ type: "approve" });
    expect(decide(policy, "std::read", { dir: "/real/p/proj", filename: "secret.txt" })).toEqual({
      type: "reject",
    });
  });
});
