import { describe, it, expect } from "vitest";
import { TypescriptPreprocessor } from "./typescriptPreprocessor.js";
import { AgencyProgram, AgencyNode } from "@/types.js";

describe("TypescriptPreprocessor - Promise.all handling", () => {
  describe.skip("_addPromiseAllCalls", () => {
    it("should add NOT Promise.all for prompt in MessageThread, should be sync instead", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "graphNode",
            nodeName: "main",
            parameters: [],
            body: [
              {
                type: "messageThread",
                threadType: "thread",
                body: [
                  {
                    type: "assignment",
                    variableName: "story",
                    typeHint: { type: "primitiveType", value: "string" },
                    value: {
                      type: "functionCall",
                      functionName: "llm",
                      arguments: [{
                        type: "string", segments: [
                          {
                            type: "text",
                            value: "Write a story",
                          },
                        ]
                      }],
                      async: true,
                    },
                  },
                  {
                    type: "assignment",
                    variableName: "fibs",
                    typeHint: {
                      type: "arrayType",
                      elementType: { type: "primitiveType", value: "number" },
                    },
                    value: {
                      type: "functionCall",
                      functionName: "llm",
                      arguments: [{
                        type: "string", segments: [
                          {
                            type: "text",
                            value: "Get fibonacci numbers",
                          },
                        ]
                      }],
                      async: true,
                    },
                  },
                ],
              },
              {
                type: "functionCall",
                functionName: "print",
                arguments: [
                  {
                    type: "variableName",
                    value: "fibs",
                  },
                  {
                    type: "variableName",
                    value: "story",
                  },
                ],
              },
            ],
          },
        ],
      };

      const preprocessor = new TypescriptPreprocessor(program);
      const result = preprocessor.preprocess();

      const mainNode = result.nodes[0];
      expect(mainNode.type).toBe("graphNode");
      if (mainNode.type !== "graphNode") return;

      // Check that Promise.all was inserted before the print call
      const promiseAllNode = mainNode.body.find(
        (node) => node.type === "rawCode",
      );
      expect(promiseAllNode).toBeUndefined();

      const messageThreadNode = mainNode.body.find(
        (node) => node.type === "messageThread",
      );
      expect(messageThreadNode).toBeDefined();
      if (messageThreadNode?.type === "messageThread") {
        const promptNodes = messageThreadNode.body.filter(
          (node) => node.type === "assignment" && node.value.type === "functionCall",
        );
        expect(promptNodes.length).toBe(2);
        for (const node of promptNodes) {
          if (node.type === "assignment" && node.value.type === "functionCall") {
            expect(node.value.async).toBe(false);
          }
        }
      }
    });

    it("should add Promise.all when variable is defined in parent and used in parent (existing behavior)", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "graphNode",
            nodeName: "main",
            parameters: [],
            body: [
              {
                type: "assignment",
                variableName: "story",
                typeHint: { type: "primitiveType", value: "string" },
                value: {
                  type: "functionCall",
                  functionName: "llm",
                  arguments: [{
                    type: "string", segments: [
                      {
                        type: "text",
                        value: "Write a story",
                      },
                    ]
                  }],
                  async: true,
                },
              },
              {
                type: "functionCall",
                functionName: "print",
                arguments: [
                  {
                    type: "variableName",
                    value: "story",
                  },
                ],
              },
            ],
          },
        ],
      };

      const preprocessor = new TypescriptPreprocessor(program);
      const result = preprocessor.preprocess();

      const mainNode = result.nodes[0];
      expect(mainNode.type).toBe("graphNode");
      if (mainNode.type !== "graphNode") return;

      // Check that Promise.all was inserted before the print call
      const promiseAllNode = mainNode.body.find(
        (node) => node.type === "rawCode",
      );
      expect(promiseAllNode).toBeDefined();
      if (promiseAllNode?.type === "rawCode") {
        expect(promiseAllNode.value).toContain("awaitPending");
        expect(promiseAllNode.value).toContain("__self.__pendingKey_story");
      }
    });

    it("should NOT add Promise.all for variables defined in nested functions", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "graphNode",
            nodeName: "main",
            parameters: [],
            body: [
              {
                type: "function",
                functionName: "helper",
                parameters: [],
                body: [
                  {
                    type: "assignment",
                    variableName: "inner",
                    value: {
                      type: "functionCall",
                      functionName: "llm",
                      arguments: [{
                        type: "string", segments: [
                          {
                            type: "text",
                            value: "Inner prompt",
                          },
                        ]
                      }],
                      async: true,
                    },
                  },
                ],
              },
              {
                type: "functionCall",
                functionName: "print",
                arguments: [
                  {
                    type: "variableName",
                    value: "inner",
                  },
                ],
              },
            ],
          },
        ],
      };

      const preprocessor = new TypescriptPreprocessor(program);
      const result = preprocessor.preprocess();

      const mainNode = result.nodes[0];
      expect(mainNode.type).toBe("graphNode");
      if (mainNode.type !== "graphNode") return;

      // Check that no Promise.all was inserted in the main body
      // (the variable 'inner' is scoped to the helper function)
      const promiseAllNode = mainNode.body.find(
        (node) =>
          node.type === "rawCode" && node.value.includes("__self.inner"),
      );
      expect(promiseAllNode).toBeUndefined();
    });

    it("should add Promise.all when multiple variables from nested bodies are used together", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "graphNode",
            nodeName: "main",
            parameters: [],
            body: [
              {
                type: "whileLoop",
                condition: {
                  type: "variableName",
                  value: "conditionVar",
                },
                body: [
                  {
                    type: "assignment",
                    variableName: "a",
                    value: {
                      type: "functionCall",
                      functionName: "llm",
                      arguments: [{ type: "string", segments: [{ type: "text", value: "Get A" }] }],
                      async: true,
                    },
                  },
                ],
              },
              {
                type: "messageThread",
                threadType: "thread",
                body: [
                  {
                    type: "assignment",
                    variableName: "b",
                    value: {
                      type: "functionCall",
                      functionName: "llm",
                      arguments: [{ type: "string", segments: [{ type: "text", value: "Get B" }] }],
                      async: true,
                    },
                  },
                ],
              },
              {
                type: "functionCall",
                functionName: "print",
                arguments: [
                  { type: "variableName", value: "a" },
                  { type: "variableName", value: "b" },
                ],
              },
            ],
          },
        ],
      };

      const preprocessor = new TypescriptPreprocessor(program);
      const result = preprocessor.preprocess();

      const mainNode = result.nodes[0];
      expect(mainNode.type).toBe("graphNode");
      if (mainNode.type !== "graphNode") return;

      // Check that Promise.all was inserted before the print call with both variables
      const promiseAllNode = mainNode.body.find(
        (node) => node.type === "rawCode",
      );
      expect(promiseAllNode).toBeDefined();
      if (promiseAllNode?.type === "rawCode") {
        expect(promiseAllNode.value).toContain("awaitPending");
        expect(promiseAllNode.value).toContain("__self.__pendingKey_a");
        expect(promiseAllNode.value).toContain("__self.__pendingKey_b");
      }
    });
  });
});
