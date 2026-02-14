import { describe, it, expect } from "vitest";
import {
  functionCallParser,
  asyncFunctionCallParser,
  syncFunctionCallParser,
  streamingPromptLiteralParser,
} from "./functionCall.js";

describe("functionCallParser", () => {
  const testCases = [
    {
      input: "test()",
      expected: {
        success: true,
        result: {
          type: "functionCall",
          functionName: "test",
          arguments: [],
        },
      },
    },
    {
      input: "greet(name)",
      expected: {
        success: true,
        result: {
          type: "functionCall",
          functionName: "greet",
          arguments: [{ type: "variableName", value: "name" }],
        },
      },
    },
    {
      input: "add(x, y)",
      expected: {
        success: true,
        result: {
          type: "functionCall",
          functionName: "add",
          arguments: [
            { type: "variableName", value: "x" },
            { type: "variableName", value: "y" },
          ],
        },
      },
    },
    {
      input: "process(a, b, c)",
      expected: {
        success: true,
        result: {
          type: "functionCall",
          functionName: "process",
          arguments: [
            { type: "variableName", value: "a" },
            { type: "variableName", value: "b" },
            { type: "variableName", value: "c" },
          ],
        },
      },
    },
    {
      input: "func(arg1,arg2)",
      expected: {
        success: true,
        result: {
          type: "functionCall",
          functionName: "func",
          arguments: [
            { type: "variableName", value: "arg1" },
            { type: "variableName", value: "arg2" },
          ],
        },
      },
    },
    {
      input: "call( arg )",
      expected: {
        success: true,
        result: {
          type: "functionCall",
          functionName: "call",
          arguments: [{ type: "variableName", value: "arg" }],
        },
      },
    },
    {
      input: "test",
      expected: { success: false },
    },
    {
      input: "test(",
      expected: { success: false },
    },
    {
      input: "test)",
      expected: { success: false },
    },
    {
      input: "()",
      expected: { success: false },
    },
    {
      input: "",
      expected: { success: false },
    },
    // Function calls with array arguments
    {
      input: "processArray([1, 2, 3])",
      expected: {
        success: true,
        result: {
          type: "functionCall",
          functionName: "processArray",
          arguments: [
            {
              type: "agencyArray",
              items: [
                { type: "number", value: "1" },
                { type: "number", value: "2" },
                { type: "number", value: "3" },
              ],
            },
          ],
        },
      },
    },
    {
      input: "processArray([1, 2, 3, 4, 5])",
      expected: {
        success: true,
        result: {
          type: "functionCall",
          functionName: "processArray",
          arguments: [
            {
              type: "agencyArray",
              items: [
                { type: "number", value: "1" },
                { type: "number", value: "2" },
                { type: "number", value: "3" },
                { type: "number", value: "4" },
                { type: "number", value: "5" },
              ],
            },
          ],
        },
      },
    },
    {
      input: "handleStrings([\"hello\", \"world\"])",
      expected: {
        success: true,
        result: {
          type: "functionCall",
          functionName: "handleStrings",
          arguments: [
            {
              type: "agencyArray",
              items: [
                { type: "string", segments: [{ type: "text", value: "hello" }] },
                { type: "string", segments: [{ type: "text", value: "world" }] },
              ],
            },
          ],
        },
      },
    },
    {
      input: "processEmpty([])",
      expected: {
        success: true,
        result: {
          type: "functionCall",
          functionName: "processEmpty",
          arguments: [
            {
              type: "agencyArray",
              items: [],
            },
          ],
        },
      },
    },
    {
      input: "processNested([[1, 2], [3, 4]])",
      expected: {
        success: true,
        result: {
          type: "functionCall",
          functionName: "processNested",
          arguments: [
            {
              type: "agencyArray",
              items: [
                {
                  type: "agencyArray",
                  items: [
                    { type: "number", value: "1" },
                    { type: "number", value: "2" },
                  ],
                },
                {
                  type: "agencyArray",
                  items: [
                    { type: "number", value: "3" },
                    { type: "number", value: "4" },
                  ],
                },
              ],
            },
          ],
        },
      },
    },
    // Function calls with object arguments
    {
      input: "configure({key: \"value\"})",
      expected: {
        success: true,
        result: {
          type: "functionCall",
          functionName: "configure",
          arguments: [
            {
              type: "agencyObject",
              entries: [
                {
                  key: "key",
                  value: { type: "string", segments: [{ type: "text", value: "value" }] },
                },
              ],
            },
          ],
        },
      },
    },
    {
      input: "createUser({name: \"Alice\", age: 30})",
      expected: {
        success: true,
        result: {
          type: "functionCall",
          functionName: "createUser",
          arguments: [
            {
              type: "agencyObject",
              entries: [
                {
                  key: "name",
                  value: { type: "string", segments: [{ type: "text", value: "Alice" }] },
                },
                {
                  key: "age",
                  value: { type: "number", value: "30" },
                },
              ],
            },
          ],
        },
      },
    },
    {
      input: "initialize({})",
      expected: {
        success: true,
        result: {
          type: "functionCall",
          functionName: "initialize",
          arguments: [
            {
              type: "agencyObject",
              entries: [],
            },
          ],
        },
      },
    },
    {
      input: "processData({items: [1, 2, 3]})",
      expected: {
        success: true,
        result: {
          type: "functionCall",
          functionName: "processData",
          arguments: [
            {
              type: "agencyObject",
              entries: [
                {
                  key: "items",
                  value: {
                    type: "agencyArray",
                    items: [
                      { type: "number", value: "1" },
                      { type: "number", value: "2" },
                      { type: "number", value: "3" },
                    ],
                  },
                },
              ],
            },
          ],
        },
      },
    },
    {
      input: "nestedConfig({outer: {inner: 42}})",
      expected: {
        success: true,
        result: {
          type: "functionCall",
          functionName: "nestedConfig",
          arguments: [
            {
              type: "agencyObject",
              entries: [
                {
                  key: "outer",
                  value: {
                    type: "agencyObject",
                    entries: [
                      {
                        key: "inner",
                        value: { type: "number", value: "42" },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      },
    },
    // Function calls with mixed arguments
    {
      input: "mixed(42, [1, 2], {key: \"value\"})",
      expected: {
        success: true,
        result: {
          type: "functionCall",
          functionName: "mixed",
          arguments: [
            { type: "number", value: "42" },
            {
              type: "agencyArray",
              items: [
                { type: "number", value: "1" },
                { type: "number", value: "2" },
              ],
            },
            {
              type: "agencyObject",
              entries: [
                {
                  key: "key",
                  value: { type: "string", segments: [{ type: "text", value: "value" }] },
                },
              ],
            },
          ],
        },
      },
    },
    {
      input: "complexCall(\"test\", [], {}, 100)",
      expected: {
        success: true,
        result: {
          type: "functionCall",
          functionName: "complexCall",
          arguments: [
            { type: "string", segments: [{ type: "text", value: "test" }] },
            {
              type: "agencyArray",
              items: [],
            },
            {
              type: "agencyObject",
              entries: [],
            },
            { type: "number", value: "100" },
          ],
        },
      },
    },
    {
      input: "withVariables(x, [y, z], {key: value})",
      expected: {
        success: true,
        result: {
          type: "functionCall",
          functionName: "withVariables",
          arguments: [
            { type: "variableName", value: "x" },
            {
              type: "agencyArray",
              items: [
                { type: "variableName", value: "y" },
                { type: "variableName", value: "z" },
              ],
            },
            {
              type: "agencyObject",
              entries: [
                {
                  key: "key",
                  value: { type: "variableName", value: "value" },
                },
              ],
            },
          ],
        },
      },
    },
  ];

  testCases.forEach(({ input, expected }) => {
    if (expected.success) {
      it(`should parse "${input}" successfully`, () => {
        const result = functionCallParser(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result).toEqual(expected.result);
        }
      });
    } else {
      it(`should fail to parse "${input}"`, () => {
          const result = functionCallParser(input);
          expect(result.success).toBe(false);
        });
    }
  });
});

describe("asyncFunctionCallParser", () => {
  const testCases = [
    // Happy path - basic async function calls
    {
      input: "async test()",
      expected: {
        success: true,
        result: {
          type: "functionCall",
          functionName: "test",
          arguments: [],
          async: true,
        },
      },
    },
    {
      input: "async greet(name)",
      expected: {
        success: true,
        result: {
          type: "functionCall",
          functionName: "greet",
          arguments: [{ type: "variableName", value: "name" }],
          async: true,
        },
      },
    },
    {
      input: "async fetchData(url, options)",
      expected: {
        success: true,
        result: {
          type: "functionCall",
          functionName: "fetchData",
          arguments: [
            { type: "variableName", value: "url" },
            { type: "variableName", value: "options" },
          ],
          async: true,
        },
      },
    },

    // Async with different argument types
    {
      input: "async calculate(42)",
      expected: {
        success: true,
        result: {
          type: "functionCall",
          functionName: "calculate",
          arguments: [{ type: "number", value: "42" }],
          async: true,
        },
      },
    },
    {
      input: 'async processString("hello")',
      expected: {
        success: true,
        result: {
          type: "functionCall",
          functionName: "processString",
          arguments: [
            { type: "string", segments: [{ type: "text", value: "hello" }] },
          ],
          async: true,
        },
      },
    },
    {
      input: "async processArray([1, 2, 3])",
      expected: {
        success: true,
        result: {
          type: "functionCall",
          functionName: "processArray",
          arguments: [
            {
              type: "agencyArray",
              items: [
                { type: "number", value: "1" },
                { type: "number", value: "2" },
                { type: "number", value: "3" },
              ],
            },
          ],
          async: true,
        },
      },
    },
    {
      input: "async configure({key: \"value\"})",
      expected: {
        success: true,
        result: {
          type: "functionCall",
          functionName: "configure",
          arguments: [
            {
              type: "agencyObject",
              entries: [
                {
                  key: "key",
                  value: {
                    type: "string",
                    segments: [{ type: "text", value: "value" }],
                  },
                },
              ],
            },
          ],
          async: true,
        },
      },
    },

    // Async with complex nested arguments
    {
      input: "async complexCall(x, [1, 2], {key: value})",
      expected: {
        success: true,
        result: {
          type: "functionCall",
          functionName: "complexCall",
          arguments: [
            { type: "variableName", value: "x" },
            {
              type: "agencyArray",
              items: [
                { type: "number", value: "1" },
                { type: "number", value: "2" },
              ],
            },
            {
              type: "agencyObject",
              entries: [
                {
                  key: "key",
                  value: { type: "variableName", value: "value" },
                },
              ],
            },
          ],
          async: true,
        },
      },
    },

    // Failure cases - missing async keyword
    { input: "test()", expected: { success: false } },
    { input: "greet(name)", expected: { success: false } },

    // Failure cases - async without space
    { input: "asynctest()", expected: { success: false } },

    // Failure cases - async keyword alone
    { input: "async", expected: { success: false } },
    { input: "async ", expected: { success: false } },

    // Failure cases - invalid function call syntax after async
    { input: "async test", expected: { success: false } },
    { input: "async test(", expected: { success: false } },

    // Failure cases - empty input
    { input: "", expected: { success: false } },
  ];

  testCases.forEach(({ input, expected }) => {
    if (expected.success) {
      it(`should parse "${input}" successfully`, () => {
        const result = asyncFunctionCallParser(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result).toEqual(expected.result);
        }
      });
    } else {
      it(`should fail to parse "${input}"`, () => {
          const result = asyncFunctionCallParser(input);
          expect(result.success).toBe(false);
        });
    }
  });
});

describe("syncFunctionCallParser", () => {
  const testCases = [
    // Happy path - sync keyword
    {
      input: "sync test()",
      expected: {
        success: true,
        result: {
          type: "functionCall",
          functionName: "test",
          arguments: [],
          async: false,
        },
      },
    },
    {
      input: "sync greet(name)",
      expected: {
        success: true,
        result: {
          type: "functionCall",
          functionName: "greet",
          arguments: [{ type: "variableName", value: "name" }],
          async: false,
        },
      },
    },
    {
      input: "sync fetchData(url, options)",
      expected: {
        success: true,
        result: {
          type: "functionCall",
          functionName: "fetchData",
          arguments: [
            { type: "variableName", value: "url" },
            { type: "variableName", value: "options" },
          ],
          async: false,
        },
      },
    },

    // Happy path - await keyword
    {
      input: "await test()",
      expected: {
        success: true,
        result: {
          type: "functionCall",
          functionName: "test",
          arguments: [],
          async: false,
        },
      },
    },
    {
      input: "await greet(name)",
      expected: {
        success: true,
        result: {
          type: "functionCall",
          functionName: "greet",
          arguments: [{ type: "variableName", value: "name" }],
          async: false,
        },
      },
    },
    {
      input: "await fetchData(url, options)",
      expected: {
        success: true,
        result: {
          type: "functionCall",
          functionName: "fetchData",
          arguments: [
            { type: "variableName", value: "url" },
            { type: "variableName", value: "options" },
          ],
          async: false,
        },
      },
    },

    // Sync/await with different argument types
    {
      input: "sync calculate(42)",
      expected: {
        success: true,
        result: {
          type: "functionCall",
          functionName: "calculate",
          arguments: [{ type: "number", value: "42" }],
          async: false,
        },
      },
    },
    {
      input: 'await processString("hello")',
      expected: {
        success: true,
        result: {
          type: "functionCall",
          functionName: "processString",
          arguments: [
            { type: "string", segments: [{ type: "text", value: "hello" }] },
          ],
          async: false,
        },
      },
    },
    {
      input: "sync processArray([1, 2, 3])",
      expected: {
        success: true,
        result: {
          type: "functionCall",
          functionName: "processArray",
          arguments: [
            {
              type: "agencyArray",
              items: [
                { type: "number", value: "1" },
                { type: "number", value: "2" },
                { type: "number", value: "3" },
              ],
            },
          ],
          async: false,
        },
      },
    },
    {
      input: "await configure({key: \"value\"})",
      expected: {
        success: true,
        result: {
          type: "functionCall",
          functionName: "configure",
          arguments: [
            {
              type: "agencyObject",
              entries: [
                {
                  key: "key",
                  value: {
                    type: "string",
                    segments: [{ type: "text", value: "value" }],
                  },
                },
              ],
            },
          ],
          async: false,
        },
      },
    },

    // Sync/await with complex nested arguments
    {
      input: "sync complexCall(x, [1, 2], {key: value})",
      expected: {
        success: true,
        result: {
          type: "functionCall",
          functionName: "complexCall",
          arguments: [
            { type: "variableName", value: "x" },
            {
              type: "agencyArray",
              items: [
                { type: "number", value: "1" },
                { type: "number", value: "2" },
              ],
            },
            {
              type: "agencyObject",
              entries: [
                {
                  key: "key",
                  value: { type: "variableName", value: "value" },
                },
              ],
            },
          ],
          async: false,
        },
      },
    },

    // Failure cases - missing sync/await keyword
    { input: "test()", expected: { success: false } },
    { input: "async test()", expected: { success: false } },

    // Failure cases - sync/await without space
    { input: "synctest()", expected: { success: false } },
    { input: "awaittest()", expected: { success: false } },

    // Failure cases - keyword alone
    { input: "sync", expected: { success: false } },
    { input: "await", expected: { success: false } },
    { input: "sync ", expected: { success: false } },
    { input: "await ", expected: { success: false } },

    // Failure cases - invalid function call syntax after keyword
    { input: "sync test", expected: { success: false } },
    { input: "await test", expected: { success: false } },
    { input: "sync test(", expected: { success: false } },
    { input: "await test(", expected: { success: false } },

    // Failure cases - empty input
    { input: "", expected: { success: false } },
  ];

  testCases.forEach(({ input, expected }) => {
    if (expected.success) {
      it(`should parse "${input}" successfully`, () => {
        const result = syncFunctionCallParser(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result).toEqual(expected.result);
        }
      });
    } else {
      it(`should fail to parse "${input}"`, () => {
          const result = syncFunctionCallParser(input);
          expect(result.success).toBe(false);
        });
    }
  });
});

describe("functionCallParser with async/sync/await keywords", () => {
  it("should parse 'async' keyword and set async: true", () => {
    const result = functionCallParser("async bar()");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result).toEqual({
        type: "functionCall",
        functionName: "bar",
        arguments: [],
        async: true,
      });
    }
  });

  it("should parse 'sync' keyword and set async: false", () => {
    const result = functionCallParser("sync bar()");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result).toEqual({
        type: "functionCall",
        functionName: "bar",
        arguments: [],
        async: false,
      });
    }
  });

  it("should parse 'await' keyword and set async: false", () => {
    const result = functionCallParser("await bar()");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result).toEqual({
        type: "functionCall",
        functionName: "bar",
        arguments: [],
        async: false,
      });
    }
  });

  it("should parse without keyword and not set async field", () => {
    const result = functionCallParser("bar()");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result).toEqual({
        type: "functionCall",
        functionName: "bar",
        arguments: [],
      });
    }
  });

  it("should parse 'await' with arguments", () => {
    const result = functionCallParser("await sayHi(name, age)");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result).toEqual({
        type: "functionCall",
        functionName: "sayHi",
        arguments: [
          { type: "variableName", value: "name" },
          { type: "variableName", value: "age" },
        ],
        async: false,
      });
    }
  });

  it("should parse 'async' with arguments", () => {
    const result = functionCallParser("async sayHi(name)");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result).toEqual({
        type: "functionCall",
        functionName: "sayHi",
        arguments: [{ type: "variableName", value: "name" }],
        async: true,
      });
    }
  });
});

describe("streamingPromptLiteralParser", () => {
  const testCases = [
    // Happy path - streaming keyword with backtick prompts
    {
      input: "streaming `Hello world`",
      expected: {
        success: true,
        result: {
          type: "prompt",
          segments: [{ type: "text", value: "Hello world" }],
          isStreaming: true,
        },
      },
    },
    {
      input: "stream `Generate a response`",
      expected: {
        success: true,
        result: {
          type: "prompt",
          segments: [{ type: "text", value: "Generate a response" }],
          isStreaming: true,
        },
      },
    },

    // Streaming with interpolation
    {
      input: "streaming `Hello ${name}`",
      expected: {
        success: true,
        result: {
          type: "prompt",
          segments: [
            { type: "text", value: "Hello " },
            { type: "interpolation", variableName: "name" },
          ],
          isStreaming: true,
        },
      },
    },
    {
      input: "stream `User ${userId} said: ${message}`",
      expected: {
        success: true,
        result: {
          type: "prompt",
          segments: [
            { type: "text", value: "User " },
            { type: "interpolation", variableName: "userId" },
            { type: "text", value: " said: " },
            { type: "interpolation", variableName: "message" },
          ],
          isStreaming: true,
        },
      },
    },

    // Streaming with llm function call
    {
      input: "streaming llm(`What is 2+2?`)",
      expected: {
        success: true,
        result: {
          type: "prompt",
          segments: [{ type: "text", value: "What is 2+2?" }],
          isStreaming: true,
        },
      },
    },
    {
      input: "stream llm(`Translate: ${text}`)",
      expected: {
        success: true,
        result: {
          type: "prompt",
          segments: [
            { type: "text", value: "Translate: " },
            { type: "interpolation", variableName: "text" },
          ],
          isStreaming: true,
        },
      },
    },

    // Streaming with llm function call and config
    {
      input: 'streaming llm(`Hello`, {model: "gpt-4"})',
      expected: {
        success: true,
        result: {
          type: "prompt",
          segments: [{ type: "text", value: "Hello" }],
          config: {
            type: "agencyObject",
            entries: [
              {
                key: "model",
                value: {
                  type: "string",
                  segments: [{ type: "text", value: "gpt-4" }],
                },
              },
            ],
          },
          isStreaming: true,
        },
      },
    },
    {
      input: 'stream llm(`Generate code`, {temperature: 0.7})',
      expected: {
        success: true,
        result: {
          type: "prompt",
          segments: [{ type: "text", value: "Generate code" }],
          config: {
            type: "agencyObject",
            entries: [
              {
                key: "temperature",
                value: { type: "number", value: "0.7" },
              },
            ],
          },
          isStreaming: true,
        },
      },
    },

    // Edge cases - empty prompt
    {
      input: "streaming ``",
      expected: {
        success: true,
        result: {
          type: "prompt",
          segments: [],
          isStreaming: true,
        },
      },
    },
    {
      input: "stream ``",
      expected: {
        success: true,
        result: {
          type: "prompt",
          segments: [],
          isStreaming: true,
        },
      },
    },

    // Failure cases - missing streaming/stream keyword
    { input: "`Hello world`", expected: { success: false } },
    { input: "llm(`Hello`)", expected: { success: false } },

    // Failure cases - streaming without space
    { input: "streaming`Hello`", expected: { success: false } },
    { input: "stream`Hello`", expected: { success: false } },

    // Failure cases - streaming keyword alone
    { input: "streaming", expected: { success: false } },
    { input: "stream", expected: { success: false } },
    { input: "streaming ", expected: { success: false } },
    { input: "stream ", expected: { success: false } },

    // Failure cases - invalid prompt syntax
    { input: "streaming Hello", expected: { success: false } },
    { input: "stream test", expected: { success: false } },

    // Failure cases - empty input
    { input: "", expected: { success: false } },
  ];

  testCases.forEach(({ input, expected }) => {
    if (expected.success) {
      it(`should parse "${input}" successfully`, () => {
        const result = streamingPromptLiteralParser(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result).toEqual(expected.result);
        }
      });
    } else {
      it(`should fail to parse "${input}"`, () => {
          const result = streamingPromptLiteralParser(input);
          expect(result.success).toBe(false);
        });
    }
  });
});
