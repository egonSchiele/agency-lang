import { describe, test, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { parseTestFileSandbox, parseTestFileFull, resolveSourceFile } from "./schema.js";

const VALID = {
  sourceFile: "fib-tests.agency",
  tests: [
    {
      nodeName: "testFive",
      input: "",
      expectedOutput: "5",
      evaluationCriteria: [{ type: "exact" }],
    },
  ],
};

function sandbox(json: unknown, filename = "fib-tests.test.json") {
  return parseTestFileSandbox(JSON.stringify(json), filename);
}

describe("parseTestFileSandbox", () => {
  test("valid file parses; expectedOutput becomes a VALUE", () => {
    const parsed = sandbox({
      ...VALID,
      tests: [
        { nodeName: "n1", input: "", expectedOutput: "5", evaluationCriteria: [{ type: "exact" }] },
        {
          nodeName: "n2",
          input: "",
          expectedOutput: '"ok"',
          evaluationCriteria: [{ type: "exact" }],
        },
        {
          nodeName: "n3",
          input: "",
          expectedOutput: '{"a":1}',
          evaluationCriteria: [{ type: "exact" }],
        },
      ],
    });
    expect(parsed.cases.map((c) => c.expected)).toEqual([5, "ok", { a: 1 }]);
    expect(parsed.sourceFile).toBe("fib-tests.agency");
  });

  test("sourceFile defaults from the json basename and explicit override wins", () => {
    const { sourceFile, ...rest } = VALID;
    expect(sandbox(rest, "my-tests.test.json").sourceFile).toBe("my-tests.agency");
    expect(sandbox(VALID, "my-tests.test.json").sourceFile).toBe("fib-tests.agency");
  });

  test("an unquoted string expectedOutput errors with quoting guidance", () => {
    expect(() =>
      sandbox({
        ...VALID,
        tests: [
          {
            nodeName: "n",
            input: "",
            expectedOutput: "ok",
            evaluationCriteria: [{ type: "exact" }],
          },
        ],
      }),
    ).toThrow(/quote|JSON/i);
  });

  test("malformed JSON is an error naming the file", () => {
    expect(() => parseTestFileSandbox("{ not json", "x.test.json")).toThrow(/x\.test\.json/);
  });

  test.each([
    ["missing", undefined],
    ["empty", []],
  ])("%s tests array is an error", (_, tests) => {
    const json: Record<string, unknown> = { ...VALID };
    if (tests === undefined) delete json.tests;
    else json.tests = tests;
    expect(() => sandbox(json)).toThrow(/tests/);
  });

  test.each([
    ["missing", undefined],
    ["empty", []],
    ["multiple", [{ type: "exact" }, { type: "exact" }]],
    ["unknown", [{ type: "llmJudge", judgePrompt: "p", desiredAccuracy: 1 }]],
  ])("%s evaluationCriteria is an error", (_, criteria) => {
    const testCase: Record<string, unknown> = {
      nodeName: "n",
      input: "",
      expectedOutput: "1",
    };
    if (criteria !== undefined) testCase.evaluationCriteria = criteria;
    expect(() => sandbox({ ...VALID, tests: [testCase] })).toThrow(/evaluationCriteria|criteria/i);
  });

  test.each([
    ["llmMocks", { tests: [{ ...VALID.tests[0], llmMocks: [] }] }],
    ["fetchMocks (case)", { tests: [{ ...VALID.tests[0], fetchMocks: [] }] }],
    ["fetchMocks (file)", { fetchMocks: [] }],
    ["fakeClock", { tests: [{ ...VALID.tests[0], fakeClock: true }] }],
    ["argv", { tests: [{ ...VALID.tests[0], argv: ["--x"] }] }],
    ["retry", { tests: [{ ...VALID.tests[0], retry: 2 }] }],
    ["skip (case)", { tests: [{ ...VALID.tests[0], skip: true }] }],
    ["skip (file)", { skip: true }],
    ["skipOnCI", { tests: [{ ...VALID.tests[0], skipOnCI: true }] }],
    ["skipReason", { skipReason: "because" }],
    ["useTestLLMProvider", { tests: [{ ...VALID.tests[0], useTestLLMProvider: true }] }],
    ["expectedCompileError", { expectedCompileError: "AG1234" }],
  ])("refused field: %s", (fieldName, patch) => {
    const bareField = fieldName.split(" ")[0];
    expect(() => sandbox({ ...VALID, ...patch })).toThrow(new RegExp(bareField));
  });

  test("modify and resolve interrupt actions are refused, naming the action", () => {
    for (const action of ["modify", "resolve"]) {
      expect(() =>
        sandbox({
          ...VALID,
          tests: [{ ...VALID.tests[0], interruptHandlers: [{ action }] }],
        }),
      ).toThrow(new RegExp(action));
    }
    expect(() =>
      sandbox({
        ...VALID,
        tests: [
          {
            ...VALID.tests[0],
            interruptHandlers: [{ action: "approve", modifiedArgs: { a: 1 } }],
          },
        ],
      }),
    ).toThrow(/modifiedArgs/);
  });

  test("approve/reject handlers map with value and expectedMessage", () => {
    const parsed = sandbox({
      ...VALID,
      tests: [
        {
          ...VALID.tests[0],
          interruptHandlers: [
            { action: "approve", value: "x", expectedMessage: "m" },
            { action: "reject" },
          ],
        },
      ],
    });
    expect(parsed.cases[0].interrupts).toEqual([
      { action: "approve", value: "x", expectedMessage: "m" },
      { action: "reject" },
    ]);
  });

  test("unknown top-level and case fields are refused by name", () => {
    expect(() => sandbox({ ...VALID, surprise: 1 })).toThrow(/surprise/);
    expect(() => sandbox({ ...VALID, tests: [{ ...VALID.tests[0], surprise: 1 }] })).toThrow(
      /surprise/,
    );
  });

  test("an exact criterion carrying extra configuration is refused", () => {
    expect(() =>
      sandbox({
        ...VALID,
        tests: [
          {
            ...VALID.tests[0],
            evaluationCriteria: [{ type: "exact", judgePrompt: "ignored" }],
          },
        ],
      }),
    ).toThrow(/exactly \[\{ "type": "exact" \}\]/);
  });

  test("invalid field types and timeouts are refused", () => {
    expect(() => sandbox({ ...VALID, defaultTimeoutMs: "soon" })).toThrow(/defaultTimeoutMs/);
    expect(() => sandbox({ ...VALID, tests: [{ ...VALID.tests[0], timeoutMs: -5 }] })).toThrow(
      /timeoutMs/,
    );
    expect(() => sandbox({ ...VALID, tests: [{ ...VALID.tests[0], nodeName: 7 }] })).toThrow(
      /nodeName/,
    );
  });

  test("valid timeouts are carried through", () => {
    const parsed = sandbox({
      ...VALID,
      defaultTimeoutMs: 1000,
      tests: [{ ...VALID.tests[0], timeoutMs: 250, description: "d" }],
    });
    expect(parsed.defaultTimeoutMs).toBe(1000);
    expect(parsed.cases[0].timeoutMs).toBe(250);
    expect(parsed.cases[0].description).toBe("d");
  });
});

describe("parseTestFileFull", () => {
  test("accepts a real repo fixture verbatim", () => {
    const fixture = fs.readFileSync(
      path.join(process.cwd(), "tests/agency/git.test.json"),
      "utf-8",
    );
    const parsed = parseTestFileFull(fixture, "git.test.json");
    expect(parsed.tests?.length).toBeGreaterThan(0);
  });

  test("accepts compile-error, mock, clock, argv, skip, resolve, and modify fixtures", () => {
    expect(
      parseTestFileFull(JSON.stringify({ expectedCompileError: "AG8001" }), "x.test.json")
        .expectedCompileError,
    ).toBe("AG8001");
    const kitchenSink = {
      sourceFile: "explicit.agency",
      skip: true,
      skipReason: "flaky",
      fetchMocks: [{ url: "https://example.com", response: { status: 200, body: "" } }],
      tests: [
        {
          nodeName: "n",
          input: "",
          expectedOutput: "1",
          evaluationCriteria: [{ type: "llmJudge", judgePrompt: "good?", desiredAccuracy: 90 }],
          llmMocks: [{ response: "hi" }],
          fakeClock: true,
          argv: ["--flag"],
          skipOnCI: true,
          useTestLLMProvider: true,
          retry: 2,
          interruptHandlers: [
            { action: "modify", modifiedArgs: { a: 1 } },
            { action: "resolve", resolvedValue: "42" },
          ],
        },
      ],
    };
    const parsed = parseTestFileFull(JSON.stringify(kitchenSink), "x.test.json");
    expect(parsed.tests?.[0].interruptHandlers?.[0].action).toBe("modify");
    // resolvedValue must survive parsing: the runner answers a `resolve`
    // action with it.
    expect(parsed.tests?.[0].interruptHandlers?.[1].resolvedValue).toBe("42");
  });

  test("unknown keys fail loudly at every nesting level", () => {
    const base = {
      tests: [
        {
          nodeName: "n",
          input: "",
          expectedOutput: "1",
          evaluationCriteria: [{ type: "exact" }] as unknown[],
          interruptHandlers: [{ action: "approve" }] as unknown[],
        },
      ],
    };
    const parse = (raw: object) => () => parseTestFileFull(JSON.stringify(raw), "x.test.json");
    expect(parse({ ...base, defaultTimeoutMS: 1 })).toThrow(/defaultTimeoutMS/);
    expect(parse({ tests: [{ ...base.tests[0], timeoutMS: 1 }] })).toThrow(/timeoutMS/);
    expect(
      parse({
        tests: [{ ...base.tests[0], interruptHandlers: [{ action: "approve", vale: 1 }] }],
      }),
    ).toThrow(/vale/);
    expect(
      parse({
        tests: [{ ...base.tests[0], evaluationCriteria: [{ type: "exact", judgePrompt: "x" }] }],
      }),
    ).toThrow(/criteria|judgePrompt/i);
  });

  test("desiredAccuracy is a 0–100 judge-score threshold, not a fraction", () => {
    const withAccuracy = (desiredAccuracy: number) =>
      JSON.stringify({
        tests: [
          {
            nodeName: "n",
            input: "",
            expectedOutput: "1",
            evaluationCriteria: [{ type: "llmJudge", judgePrompt: "good?", desiredAccuracy }],
          },
        ],
      });
    expect(() => parseTestFileFull(withAccuracy(70), "x.test.json")).not.toThrow();
    expect(() => parseTestFileFull(withAccuracy(101), "x.test.json")).toThrow(/0–100|100/);
  });

  test("empty and unknown evaluationCriteria are errors in the full profile too", () => {
    const withCriteria = (criteria: unknown) =>
      JSON.stringify({
        tests: [{ nodeName: "n", input: "", expectedOutput: "1", evaluationCriteria: criteria }],
      });
    expect(() => parseTestFileFull(withCriteria([]), "x.test.json")).toThrow(/criteria/i);
    expect(() => parseTestFileFull(withCriteria([{ type: "vibes" }]), "x.test.json")).toThrow(
      /vibes|criteria/i,
    );
    expect(() => parseTestFileFull(withCriteria(undefined), "x.test.json")).toThrow(/criteria/i);
  });
});

describe("resolveSourceFile", () => {
  test("explicit sourceFile wins; default derives from the json basename", () => {
    expect(resolveSourceFile(undefined, "abc.test.json")).toBe("abc.agency");
    expect(resolveSourceFile("other.agency", "abc.test.json")).toBe("other.agency");
  });
});
