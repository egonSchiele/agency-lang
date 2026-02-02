import { describe, it, expect } from "vitest";
import {
  agencyArrayParser,
  agencyObjectParser,
  agencyObjectKVParser,
} from "./dataStructures.js";

describe("dataStructures parsers", () => {
  describe("agencyArrayParser", () => {
    const testCases = [
      // Empty arrays
      {
        input: "[]",
        expected: {
          success: true,
          result: {
            type: "agencyArray",
            items: [],
          },
        },
      },

      // Simple arrays with literals
      {
        input: "[1]",
        expected: {
          success: true,
          result: {
            type: "agencyArray",
            items: [{ type: "number", value: "1" }],
          },
        },
      },
      {
        input: "[1, 2, 3]",
        expected: {
          success: true,
          result: {
            type: "agencyArray",
            items: [
              { type: "number", value: "1" },
              { type: "number", value: "2" },
              { type: "number", value: "3" },
            ],
          },
        },
      },
      {
        input: '["hello", "world"]',
        expected: {
          success: true,
          result: {
            type: "agencyArray",
            items: [
              { type: "string", segments: [{ type: "text", value: "hello" }] },
              { type: "string", segments: [{ type: "text", value: "world" }] },
            ],
          },
        },
      },

      // Arrays with variables
      {
        input: "[x, y, z]",
        expected: {
          success: true,
          result: {
            type: "agencyArray",
            items: [
              { type: "variableName", value: "x" },
              { type: "variableName", value: "y" },
              { type: "variableName", value: "z" },
            ],
          },
        },
      },

      // Mixed type arrays
      {
        input: '[1, "hello", foo]',
        expected: {
          success: true,
          result: {
            type: "agencyArray",
            items: [
              { type: "number", value: "1" },
              { type: "string", segments: [{ type: "text", value: "hello" }] },
              { type: "variableName", value: "foo" },
            ],
          },
        },
      },

      // Nested arrays
      {
        input: "[[1, 2], [3, 4]]",
        expected: {
          success: true,
          result: {
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
        },
      },
      {
        input: "[[[]]]",
        expected: {
          success: true,
          result: {
            type: "agencyArray",
            items: [
              {
                type: "agencyArray",
                items: [
                  {
                    type: "agencyArray",
                    items: [],
                  },
                ],
              },
            ],
          },
        },
      },

      // Arrays with minimal whitespace
      {
        input: "[1,2,3]",
        expected: {
          success: true,
          result: {
            type: "agencyArray",
            items: [
              { type: "number", value: "1" },
              { type: "number", value: "2" },
              { type: "number", value: "3" },
            ],
          },
        },
      },

      // Arrays with negative numbers
      {
        input: "[-1, -2.5, 3]",
        expected: {
          success: true,
          result: {
            type: "agencyArray",
            items: [
              { type: "number", value: "-1" },
              { type: "number", value: "-2.5" },
              { type: "number", value: "3" },
            ],
          },
        },
      },

      // Failure cases
      { input: "[", expected: { success: false } },
      { input: "]", expected: { success: false } },
      { input: "[1,", expected: { success: false } },
      { input: "[,1]", expected: { success: false } },
      { input: "", expected: { success: false } },
    ];

    testCases.forEach(({ input, expected }) => {
      if (expected.success) {
        it(`should parse "${input}" successfully`, () => {
          const result = agencyArrayParser(input);
          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.result).toEqual(expected.result);
          }
        });
      } else {
        it(`should fail to parse "${input}"`, () => {
          const result = agencyArrayParser(input);
          expect(result.success).toBe(false);
        });
      }
    });
  });

  describe("agencyObjectKVParser", () => {
    const testCases = [
      // Simple key-value pairs
      {
        input: "foo: 1",
        expected: {
          success: true,
          result: {
            key: "foo",
            value: { type: "number", value: "1" },
          },
        },
      },
      {
        input: "bar: 2",
        expected: {
          success: true,
          result: {
            key: "bar",
            value: { type: "number", value: "2" },
          },
        },
      },
      {
        input: 'name: "Alice"',
        expected: {
          success: true,
          result: {
            key: "name",
            value: { type: "string", segments: [{ type: "text", value: "Alice" }] },
          },
        },
      },

      // Quoted keys
      {
        input: '"foo": 1',
        expected: {
          success: true,
          result: {
            key: "foo",
            value: { type: "number", value: "1" },
          },
        },
      },
      {
        input: '"name": "Alice"',
        expected: {
          success: true,
          result: {
            key: "name",
            value: { type: "string", segments: [{ type: "text", value: "Alice" }] },
          },
        },
      },

      // Keys with whitespace
      {
        input: "  foo  :  1  ",
        expected: {
          success: true,
          result: {
            key: "foo",
            value: { type: "number", value: "1" },
          },
        },
      },
      {
        input: "foo:1",
        expected: {
          success: true,
          result: {
            key: "foo",
            value: { type: "number", value: "1" },
          },
        },
      },

      // Variable values
      {
        input: "foo: bar",
        expected: {
          success: true,
          result: {
            key: "foo",
            value: { type: "variableName", value: "bar" },
          },
        },
      },

      // Nested object values
      {
        input: "foo: {bar: 1}",
        expected: {
          success: true,
          result: {
            key: "foo",
            value: {
              type: "agencyObject",
              entries: [
                {
                  key: "bar",
                  value: { type: "number", value: "1" },
                },
              ],
            },
          },
        },
      },

      // Array values
      {
        input: "foo: [1, 2, 3]",
        expected: {
          success: true,
          result: {
            key: "foo",
            value: {
              type: "agencyArray",
              items: [
                { type: "number", value: "1" },
                { type: "number", value: "2" },
                { type: "number", value: "3" },
              ],
            },
          },
        },
      },

      // Failure cases
      { input: "foo", expected: { success: false } },
      { input: "foo:", expected: { success: false } },
      { input: "", expected: { success: false } },
    ];

    testCases.forEach(({ input, expected }) => {
      if (expected.success) {
        it(`should parse "${input}" successfully`, () => {
          const result = agencyObjectKVParser(input);
          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.result).toEqual(expected.result);
          }
        });
      } else {
        it(`should fail to parse "${input}"`, () => {
          const result = agencyObjectKVParser(input);
          expect(result.success).toBe(false);
        });
      }
    });
  });

  describe("agencyObjectParser", () => {
    const testCases = [
      // Empty objects
      {
        input: "{}",
        expected: {
          success: true,
          result: {
            type: "agencyObject",
            entries: [],
          },
        },
      },
      {
        input: "{  }",
        expected: {
          success: true,
          result: {
            type: "agencyObject",
            entries: [],
          },
        },
      },

      // Single entry objects
      {
        input: "{foo: 1}",
        expected: {
          success: true,
          result: {
            type: "agencyObject",
            entries: [
              {
                key: "foo",
                value: { type: "number", value: "1" },
              },
            ],
          },
        },
      },
      {
        input: '{"name": "Alice"}',
        expected: {
          success: true,
          result: {
            type: "agencyObject",
            entries: [
              {
                key: "name",
                value: { type: "string", segments: [{ type: "text", value: "Alice" }] },
              },
            ],
          },
        },
      },

      // Multiple entries
      {
        input: "{foo: 1, bar: 2}",
        expected: {
          success: true,
          result: {
            type: "agencyObject",
            entries: [
              {
                key: "foo",
                value: { type: "number", value: "1" },
              },
              {
                key: "bar",
                value: { type: "number", value: "2" },
              },
            ],
          },
        },
      },
      {
        input: '{name: "Alice", age: 30, city: "NYC"}',
        expected: {
          success: true,
          result: {
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
              {
                key: "city",
                value: { type: "string", segments: [{ type: "text", value: "NYC" }] },
              },
            ],
          },
        },
      },

      // Objects with trailing commas
      {
        input: "{foo: 1,}",
        expected: {
          success: true,
          result: {
            type: "agencyObject",
            entries: [
              {
                key: "foo",
                value: { type: "number", value: "1" },
              },
            ],
          },
        },
      },
      {
        input: "{foo: 1, bar: 2,}",
        expected: {
          success: true,
          result: {
            type: "agencyObject",
            entries: [
              {
                key: "foo",
                value: { type: "number", value: "1" },
              },
              {
                key: "bar",
                value: { type: "number", value: "2" },
              },
            ],
          },
        },
      },

      // Objects with whitespace variations
      {
        input: "{ foo : 1 , bar : 2 }",
        expected: {
          success: true,
          result: {
            type: "agencyObject",
            entries: [
              {
                key: "foo",
                value: { type: "number", value: "1" },
              },
              {
                key: "bar",
                value: { type: "number", value: "2" },
              },
            ],
          },
        },
      },
      {
        input: "{foo:1,bar:2}",
        expected: {
          success: true,
          result: {
            type: "agencyObject",
            entries: [
              {
                key: "foo",
                value: { type: "number", value: "1" },
              },
              {
                key: "bar",
                value: { type: "number", value: "2" },
              },
            ],
          },
        },
      },

      // Nested objects
      {
        input: "{outer: {inner: 1}}",
        expected: {
          success: true,
          result: {
            type: "agencyObject",
            entries: [
              {
                key: "outer",
                value: {
                  type: "agencyObject",
                  entries: [
                    {
                      key: "inner",
                      value: { type: "number", value: "1" },
                    },
                  ],
                },
              },
            ],
          },
        },
      },
      {
        input: "{a: {b: {c: 1}}}",
        expected: {
          success: true,
          result: {
            type: "agencyObject",
            entries: [
              {
                key: "a",
                value: {
                  type: "agencyObject",
                  entries: [
                    {
                      key: "b",
                      value: {
                        type: "agencyObject",
                        entries: [
                          {
                            key: "c",
                            value: { type: "number", value: "1" },
                          },
                        ],
                      },
                    },
                  ],
                },
              },
            ],
          },
        },
      },

      // Objects with array values
      {
        input: "{nums: [1, 2, 3]}",
        expected: {
          success: true,
          result: {
            type: "agencyObject",
            entries: [
              {
                key: "nums",
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
        },
      },

      // Objects with variable values
      {
        input: "{foo: bar, baz: qux}",
        expected: {
          success: true,
          result: {
            type: "agencyObject",
            entries: [
              {
                key: "foo",
                value: { type: "variableName", value: "bar" },
              },
              {
                key: "baz",
                value: { type: "variableName", value: "qux" },
              },
            ],
          },
        },
      },

      // Mixed types
      {
        input: '{name: "Alice", age: 30, active: true, tags: ["a", "b"]}',
        expected: {
          success: true,
          result: {
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
              {
                key: "active",
                value: { type: "variableName", value: "true" },
              },
              {
                key: "tags",
                value: {
                  type: "agencyArray",
                  items: [
                    { type: "string", segments: [{ type: "text", value: "a" }] },
                    { type: "string", segments: [{ type: "text", value: "b" }] },
                  ],
                },
              },
            ],
          },
        },
      },

      // Failure cases
      { input: "{", expected: { success: false } },
      { input: "}", expected: { success: false } },
      { input: "{foo}", expected: { success: false } },
      { input: "{foo:}", expected: { success: false } },
      { input: "", expected: { success: false } },
    ];

    testCases.forEach(({ input, expected }) => {
      if (expected.success) {
        it(`should parse "${input}" successfully`, () => {
          const result = agencyObjectParser(input);
          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.result).toEqual(expected.result);
          }
        });
      } else {
        it(`should fail to parse "${input}"`, () => {
          const result = agencyObjectParser(input);
          expect(result.success).toBe(false);
        });
      }
    });
  });
});
