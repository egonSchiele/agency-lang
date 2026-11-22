import { describe, expect, it } from "vitest";
import type { ScopedField } from "./alwaysScope.js";
import { builtinEffectSets } from "./effectSets.js";
import {
  buildScopedMatch,
  decisionForOfferedKey,
  picksWithoutAsking,
  promptOptions,
  resolvePromptOption,
  stripControlChars,
  type PromptContext,
  type PromptStep,
  type ResolvedPromptOption,
  type RulePicks,
} from "./interruptPromptOptions.js";
import { approvalQuestion, parsePromptAnswer, type Intr } from "./interruptPrompts.js";
import { MAX_PATTERN_LENGTH, type Policy } from "./policy.js";

const under = (field: string): ScopedField => ({ field, matchSubpaths: true });
const exact = (field: string): ScopedField => ({ field, matchSubpaths: false });
const prefix = (field: string): ScopedField => ({
  field,
  matchSubpaths: false,
  matchPrefix: true,
});

const PROJECT = "/Users/me/proj";

function contextWith(overrides: Record<string, ScopedField[]> = {}): PromptContext {
  return {
    overrides,
    registered: {
      "std::read": [under("dir")],
      "std::env": [exact("name")],
      // The declaration does not carry these tags until std::exec moves to
      // them; the context is what the functions read.
      "std::exec": [exact("command"), prefix("args"), under("cwd")],
    },
    sets: builtinEffectSets(),
    dirs: {
      cwd: PROJECT,
      home: "/Users/me",
      agentHome: "/Users/me/.agency-agent",
      agencyInstallDir: null,
    },
  };
}

const context = contextWith();

function interrupt(effect: string, data: Record<string, unknown>, expectsValue = false): Intr {
  return { effect, message: "Are you sure?", data, origin: "test", expectsValue };
}

const readInProject = interrupt("std::read", { dir: `${PROJECT}/src`, filename: "a.ts" });
const gitStatus = interrupt("std::exec", { command: "git", args: ["status"] });
const envRead = interrupt("std::env", { name: "HOME" });
const exec = (command: string, args: string[], cwd: string) =>
  interrupt("std::exec", { command, args, cwd });
const buildInSub = exec("pnpm", ["run", "build"], `${PROJECT}/sub`);

const keys = (intr: Intr, where = context) => promptOptions(intr, where).map((one) => one.key);

const folderStep = (folders: { id: string; note?: string }[]): PromptStep => ({
  id: "folder",
  question: "Which folder should this cover?",
  choices: folders.map((folder) => ({ ...folder, label: folder.id })),
});

const projectFolders = folderStep([
  { id: `${PROJECT}/src` },
  { id: PROJECT, note: "the launch directory" },
]);

type PickArgs = { intr: Intr; key: string; picks?: Partial<RulePicks>; policy?: Policy };

function resolved(args: PickArgs): ResolvedPromptOption {
  const result = resolvePromptOption({ policy: {}, ...args, context });
  if (!result.success) {
    throw new Error(result.error);
  }
  return result.value;
}

function refusal(args: PickArgs): string {
  const result = resolvePromptOption({ policy: {}, ...args, context });
  return result.success ? "" : result.error;
}

describe("promptOptions", () => {
  it("offers every option for a file read inside the launch folder", () => {
    expect(promptOptions(readInProject, context)).toEqual([
      { key: "a", label: "approve once", response: "approve", steps: [] },
      {
        key: "aa",
        label: "always approve",
        response: "approve",
        detail: "every std::read",
        steps: [],
      },
      {
        key: "ap",
        label: "always approve when",
        response: "approve",
        detail: `dir = ${PROJECT}/src and below`,
        steps: [projectFolders],
      },
      {
        key: "as",
        label: "always approve all reads in",
        response: "approve",
        detail: `${PROJECT}/src and below`,
        steps: [projectFolders],
      },
      { key: "r", label: "reject once", response: "reject", steps: [] },
      {
        key: "rr",
        label: "always reject",
        response: "reject",
        detail: "every std::read",
        steps: [],
      },
    ]);
  });

  it("offers no set-wide option when there is no folder a rule may cover", () => {
    // The home directory: a read grant there would cover ~/.ssh.
    expect(keys(interrupt("std::read", { dir: "/Users/me" }))).toEqual([
      "a",
      "aa",
      "ap",
      "r",
      "rr",
    ]);
  });

  it("lists no steps when the rule has one width", () => {
    const options = promptOptions(envRead, context);
    expect(options.map((one) => one.key)).toEqual(["a", "aa", "ap", "r", "rr"]);
    expect(options[2]).toMatchObject({ detail: "name = HOME", steps: [] });
    // One folder is no choice either.
    const etc = promptOptions(interrupt("std::read", { dir: "/etc" }), context);
    expect(etc.find((one) => one.key === "ap")?.steps).toEqual([]);
  });

  it("asks how much of a command, then which folder, for a command in a sub-folder", () => {
    const ap = promptOptions(buildInSub, context).find((one) => one.key === "ap");
    expect(ap?.steps.map((step) => step.id)).toEqual(["items", "folder"]);
    expect(ap?.steps[0]).toEqual({
      id: "items",
      question: "Which commands should this cover?",
      choices: [
        { id: "exact", label: "pnpm run build", note: "this exact command" },
        { id: "2", label: "pnpm run build …" },
        { id: "1", label: "pnpm run …" },
      ],
    });
    expect(ap?.detail).toBe(`command = pnpm, args = run build, cwd = ${PROJECT}/sub and below`);
  });

  it("asks nothing for a bare program in the launch directory", () => {
    const ap = promptOptions(exec("make", [], PROJECT), context).find((one) => one.key === "ap");
    expect(ap?.steps).toEqual([]);
  });

  it("asks only how much of the command for a command in the launch directory", () => {
    const ap = promptOptions(exec("pnpm", ["test"], PROJECT), context).find(
      (one) => one.key === "ap",
    );
    expect(ap?.steps.map((step) => step.id)).toEqual(["items"]);
    expect(ap?.steps[0].choices).toHaveLength(2);
  });

  it("offers std::exec no set-wide answer", () => {
    expect(keys(buildInSub)).toEqual(["a", "aa", "ap", "r", "rr"]);
  });

  it("cuts a long argument short in a label, and only there", () => {
    const script = "x".repeat(100);
    const ap = promptOptions(exec("python3", ["-c", script], PROJECT), context).find(
      (one) => one.key === "ap",
    );
    expect(ap?.steps[0].choices[0].label).toBe(`python3 -c ${"x".repeat(60)}…`);
    const { policy } = resolved({
      intr: exec("python3", ["-c", script], PROJECT),
      key: "ap",
      picks: { items: "exact" },
    });
    expect(policy["std::exec"][0].match?.args).toEqual(["-c", script]);
  });

  it("offers no scoped option for an effect that declares no scope", () => {
    expect(keys(interrupt("my::effect", { anything: 1 }))).toEqual(["a", "aa", "r", "rr"]);
    // An effect named like an Object.prototype property has no scope either.
    expect(keys(interrupt("constructor", {}))).toEqual(["a", "aa", "r", "rr"]);
  });

  it("offers no scoped option when an override turns the scope off", () => {
    expect(keys(readInProject, contextWith({ "std::read": [] }))).toEqual(["a", "aa", "r", "rr"]);
  });

  it("offers no scoped option when a scoped value is missing", () => {
    // An empty match would approve every interrupt of the effect.
    expect(keys(interrupt("std::read", { filename: "a.ts" }))).toEqual(["a", "aa", "r", "rr"]);
    expect(keys({ ...readInProject, data: null })).toEqual(["a", "aa", "r", "rr"]);
  });

  it("offers a raise that expects a value only the options that answer once", () => {
    expect(keys(interrupt("std::read", { dir: `${PROJECT}/src` }, true))).toEqual(["a", "r"]);
  });

  it("removes control characters from the text it shows", () => {
    const sneaky = interrupt("std::env", { name: "ls\u{202e}\x1b[8mx" });
    expect(promptOptions(sneaky, context)[2].detail).toBe("name = ls[8mx");
    const sneakyArgs = exec("ls\u{202e}", ["\x1b[8mx"], PROJECT);
    const ap = promptOptions(sneakyArgs, context).find((one) => one.key === "ap");
    expect(ap?.steps[0].choices[0].label).toBe("ls [8mx");
  });
});

describe("resolvePromptOption", () => {
  it("answers once without touching the policy", () => {
    const policy: Policy = { "std::read": [{ action: "propagate" }] };
    const approved = resolved({ intr: readInProject, key: "a", policy });
    expect(approved.response).toEqual({ type: "approve", value: undefined });
    expect(approved.policy).toBe(policy);
    expect(resolved({ intr: readInProject, key: "r", policy }).response.type).toBe("reject");
  });

  it("saves an effect-wide rule for the two effect-wide options", () => {
    expect(resolved({ intr: buildInSub, key: "aa" })).toEqual({
      response: { type: "approve", value: undefined },
      policy: { "std::exec": [{ action: "approve" }] },
    });
    expect(resolved({ intr: buildInSub, key: "rr" })).toMatchObject({
      response: { type: "reject" },
      policy: { "std::exec": [{ action: "reject" }] },
    });
  });

  it("saves the command width and the folder picked", () => {
    const { policy } = resolved({
      intr: buildInSub,
      key: "ap",
      picks: { items: "1", folder: PROJECT },
    });
    expect(policy).toEqual({
      "std::exec": [
        {
          match: { command: "pnpm", args: ["run", "**"], cwd: `{${PROJECT},${PROJECT}/**}` },
          action: "approve",
          matchDotFolders: true,
        },
      ],
    });
  });

  it("refuses picks that do not fit the steps the option listed", () => {
    // A step the option did not list.
    expect(refusal({ intr: envRead, key: "ap", picks: { items: "exact" } })).toContain(
      "has no items step",
    );
    // A missing pick for a listed step.
    expect(refusal({ intr: buildInSub, key: "ap", picks: { folder: PROJECT } })).toContain(
      "needs a pick for its items step",
    );
    // Widths that were not offered.
    expect(
      refusal({ intr: buildInSub, key: "ap", picks: { items: "0", folder: PROJECT } }),
    ).toContain("not one of the choices");
    expect(
      refusal({ intr: buildInSub, key: "ap", picks: { items: "5", folder: PROJECT } }),
    ).toContain("not one of the choices");
    // A folder outside the list.
    expect(
      refusal({ intr: buildInSub, key: "ap", picks: { items: "1", folder: "/Users/me" } }),
    ).toContain("not one of the choices");
  });

  it("puts an always-approve rule ahead of a catch-all, and saves it once", () => {
    const policy: Policy = { "std::read": [{ action: "propagate" }] };
    const once = resolved({ intr: readInProject, key: "aa", policy }).policy;
    expect(once["std::read"]).toEqual([{ action: "approve" }, { action: "propagate" }]);
    expect(resolved({ intr: readInProject, key: "aa", policy: once }).policy).toEqual(once);
  });

  it("puts an always-reject rule ahead of a catch-all and behind the rules before it", () => {
    const approved = { match: { dir: `{${PROJECT},${PROJECT}/**}` }, action: "approve" as const };
    const policy: Policy = { "std::read": [approved, { action: "propagate" }] };
    const once = resolved({ intr: readInProject, key: "rr", policy }).policy;
    expect(once["std::read"]).toEqual([approved, { action: "reject" }, { action: "propagate" }]);
    expect(resolved({ intr: readInProject, key: "rr", policy: once }).policy).toEqual(once);
  });

  it("saves a rule for the folder picked", () => {
    const { policy } = resolved({ intr: readInProject, key: "ap", picks: { folder: PROJECT } });
    expect(policy).toEqual({
      "std::read": [
        {
          match: { dir: `{${PROJECT},${PROJECT}/**}` },
          action: "approve",
          matchDotFolders: true,
        },
      ],
    });
  });

  it("pins the exact values when the rule has one width", () => {
    expect(resolved({ intr: envRead, key: "ap" }).policy).toEqual({
      "std::env": [{ match: { name: "HOME" }, action: "approve" }],
    });
  });

  it("uses the only folder there is without being told it", () => {
    const { policy } = resolved({ intr: interrupt("std::read", { dir: "/etc" }), key: "ap" });
    expect(policy["std::read"][0].match).toEqual({ dir: "{/etc,/etc/**}" });
  });

  it("puts the rule after a reject the user saved", () => {
    const reject = { match: { dir: `${PROJECT}/secrets/**` }, action: "reject" as const };
    const policy: Policy = { "std::read": [reject, { action: "propagate" }] };
    const next = resolved({
      intr: readInProject,
      key: "ap",
      picks: { folder: PROJECT },
      policy,
    }).policy;
    expect(next["std::read"].map((rule) => rule.action)).toEqual([
      "reject",
      "approve",
      "propagate",
    ]);
  });

  it("saves a set-wide rule under every member the policy does not reject", () => {
    const policy: Policy = { "std::grep": [{ action: "reject" }] };
    const next = resolved({
      intr: readInProject,
      key: "as",
      picks: { folder: PROJECT },
      policy,
    }).policy;
    expect(next["std::grep"]).toEqual([{ action: "reject" }]);
    expect(Object.keys(next).sort()).toEqual([...builtinEffectSets()["FileRead"].members].sort());
    expect(next["std::ls"]).toEqual(next["std::read"]);
  });

  it("saves the same rule once when the same option is picked twice", () => {
    const picks = { folder: PROJECT };
    const once = resolved({ intr: readInProject, key: "ap", picks }).policy;
    const twice = resolved({ intr: readInProject, key: "ap", picks, policy: once });
    expect(twice.policy).toEqual(once);
  });

  it("refuses a key the interrupt does not offer", () => {
    expect(refusal({ intr: readInProject, key: "zz" })).toContain("not one of the options");
    // "aa" exists, but not for a raise that expects a value.
    const question = interrupt("std::read", { dir: `${PROJECT}/src` }, true);
    expect(refusal({ intr: question, key: "aa" })).toContain("not one of the options");
    // No declared scope, so no scoped option to pick.
    expect(refusal({ intr: interrupt("my::effect", {}), key: "ap" })).not.toBe("");
  });

  it("refuses a folder the option does not offer", () => {
    // The home directory is not in the list, so a pick can't widen to it.
    expect(refusal({ intr: readInProject, key: "ap", picks: { folder: "/Users/me" } })).toContain(
      "not one of the choices",
    );
    expect(refusal({ intr: readInProject, key: "ap" })).toContain(
      "needs a pick for its folder step",
    );
    expect(refusal({ intr: envRead, key: "ap", picks: { folder: "/x" } })).toContain(
      "has no folder step",
    );
    expect(refusal({ intr: readInProject, key: "a", picks: { folder: PROJECT } })).toContain(
      "has no folder step",
    );
  });
});

describe("picksWithoutAsking", () => {
  it("is null for a part only when there are several choices for it", () => {
    expect(picksWithoutAsking(readInProject, "approve-always-here", context)).toEqual({
      items: "",
      folder: null,
    });
    expect(picksWithoutAsking(readInProject, "approve-always-set", context).folder).toBeNull();
    // An option whose rule has no scope never asks.
    expect(picksWithoutAsking(readInProject, "approve-always", context)).toEqual({
      items: "",
      folder: "",
    });
    expect(picksWithoutAsking(readInProject, "approve", context)).toEqual({
      items: "",
      folder: "",
    });
    // One folder is no choice.
    const inEtc = interrupt("std::read", { dir: "/etc" });
    expect(picksWithoutAsking(inEtc, "approve-always-here", context).folder).toBe("/etc");
    // No folder to widen to.
    expect(picksWithoutAsking(envRead, "approve-always-here", context).folder).toBe("");
  });

  it("gives the only width of a bare program, and asks about a command with arguments", () => {
    expect(picksWithoutAsking(exec("make", [], PROJECT), "approve-always-here", context)).toEqual({
      items: "exact",
      folder: PROJECT,
    });
    expect(picksWithoutAsking(buildInSub, "approve-always-here", context)).toEqual({
      items: null,
      folder: null,
    });
  });
});

describe("buildScopedMatch", () => {
  const prefix = (field: string): ScopedField => ({
    field,
    matchSubpaths: false,
    matchPrefix: true,
  });
  const listContext: PromptContext = {
    ...context,
    registered: { "test::run": [exact("command"), prefix("args"), under("cwd")] },
  };
  const run = (data: Record<string, unknown>) =>
    interrupt("test::run", { command: "pnpm", cwd: "/x", ...data });
  const build = run({ args: ["run", "build"] });

  it("pins the whole list when no choice is given", () => {
    expect(buildScopedMatch(build, listContext)).toEqual({
      command: "pnpm",
      args: ["run", "build"],
      cwd: "{/x,/x/**}",
    });
  });

  it("pins the leading items the choice keeps, then the rest marker", () => {
    expect(buildScopedMatch(build, listContext, "1").args).toEqual(["run", "**"]);
  });

  it("returns {} for a choice this list does not offer", () => {
    expect(buildScopedMatch(build, listContext, "0")).toEqual({});
    expect(buildScopedMatch(build, listContext, "9")).toEqual({});
  });

  it("returns {} when the list is missing or is not a list", () => {
    expect(buildScopedMatch(run({}), listContext)).toEqual({});
    expect(buildScopedMatch(run({ args: "run build" }), listContext)).toEqual({});
  });

  it("pins an empty list as an empty list", () => {
    expect(buildScopedMatch(run({ args: [] }), listContext).args).toEqual([]);
  });

  it("escapes the folder it pins below", () => {
    expect(buildScopedMatch(run({ args: [], cwd: "/a{b}" }), listContext).cwd).toBe(
      "{/a\\{b\\},/a\\{b\\}/**}",
    );
  });

  it("pins a list under plain @always as a list of escaped items", () => {
    const exactList: PromptContext = { ...context, registered: { "test::run": [exact("args")] } };
    expect(buildScopedMatch(run({ args: ["a", "b*"] }), exactList)).toEqual({
      args: ["a", "b\\*"],
    });
  });

  it("returns {} when a pinned value is longer than a pattern may be", () => {
    const long = "a".repeat(MAX_PATTERN_LENGTH + 1);
    expect(buildScopedMatch(run({ args: ["-c", long] }), listContext)).toEqual({});
    expect(buildScopedMatch(run({ args: [], command: long }), listContext)).toEqual({});
  });
});

describe("decisionForOfferedKey", () => {
  it("reads a key only among the keys that were offered", () => {
    expect(decisionForOfferedKey("ap", ["a", "ap", "r"])).toBe("approve-always-here");
    expect(decisionForOfferedKey("aa", ["a", "r"])).toBeNull();
    expect(decisionForOfferedKey("b", ["b"])).toBeNull();
  });
});

describe("stripControlChars", () => {
  it("keeps tabs and newlines, and turns CRLF into LF", () => {
    expect(stripControlChars("a\tb\r\nc\rd")).toBe("a\tb\ncd");
  });
  it("removes escape codes, bidi overrides and zero-width characters", () => {
    expect(stripControlChars("x\x1b[2Jy\u{202e}z\u{200b}w\u{feff}")).toBe("x[2Jyzw");
  });
});

describe("the runtime's own terminal prompt", () => {
  it("lists the four options that need only the effect's name", () => {
    expect(approvalQuestion(gitStatus)).toMatch(
      /\(a\)pprove \/ \(r\)eject \/ \(aa\) approve-always \/ \(rr\) reject-always: $/,
    );
  });
  it("does not read a key for an option it does not offer", () => {
    expect(parsePromptAnswer("ap")).toBe("reject");
    expect(parsePromptAnswer("as")).toBe("reject");
    expect(parsePromptAnswer("approve-always-here")).toBe("reject");
  });
});
