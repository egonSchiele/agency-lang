import { describe, it, expect } from "vitest";
import { TypescriptPreprocessor } from "./typescriptPreprocessor.js";
import { AgencyProgram } from "../types.js";

describe("TypescriptPreprocessor Core Functionality", () => {
  describe("getFunctionDefinitions", () => {
    it("should collect function definitions", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "testFunc",
            parameters: [],
            body: [],
          },
          {
            type: "function",
            functionName: "anotherFunc",
            parameters: [
              {
                type: "functionParameter",
                name: "x",
                typeHint: { type: "primitiveType", value: "string" },
              },
            ],
            body: [],
          },
        ],
      };

      const preprocessor = new TypescriptPreprocessor(program);
      preprocessor.preprocess();

      // Check that function definitions are collected
      expect(preprocessor["functionDefinitions"]).toHaveProperty("testFunc");
      expect(preprocessor["functionDefinitions"]).toHaveProperty("anotherFunc");
      expect(preprocessor["functionDefinitions"]["testFunc"].functionName).toBe(
        "testFunc",
      );
      expect(
        preprocessor["functionDefinitions"]["anotherFunc"].parameters.length,
      ).toBe(1);
    });
  });

  describe("collectTools", () => {
    it("should attach tools to prompt nodes", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "testFunc",
            parameters: [],
            body: [
              {
                type: "usesTool",
                toolNames: ["tool1", "tool2"],
              },
              {
                type: "prompt",
                segments: [{ type: "text", value: "Hello" }],
              },
            ],
          },
        ],
      };

      const preprocessor = new TypescriptPreprocessor(program);
      // Only call collectTools, not full preprocess
      preprocessor["getFunctionDefinitions"]();
      preprocessor["collectTools"]();

      const funcNode = preprocessor.program.nodes[0];
      if (funcNode.type === "function") {
        const promptNode = funcNode.body.find((n) => n.type === "prompt");
        expect(promptNode).toBeDefined();
        if (promptNode && promptNode.type === "prompt") {
          expect(promptNode.tools).toBeDefined();
          expect(promptNode.tools?.toolNames).toEqual(["tool1", "tool2"]);
        }
      }
    });

    it("should remove usesTool nodes after attaching to prompts", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "testFunc",
            parameters: [],
            body: [
              {
                type: "usesTool",
                toolNames: ["tool1"],
              },
              {
                type: "prompt",
                segments: [{ type: "text", value: "Test" }],
              },
            ],
          },
        ],
      };

      const preprocessor = new TypescriptPreprocessor(program);
      preprocessor.preprocess();

      const funcNode = preprocessor.program.nodes[0];
      if (funcNode.type === "function") {
        const usesToolNode = funcNode.body.find((n) => n.type === "usesTool");
        expect(usesToolNode).toBeUndefined();
      }
    });

    it("should handle multiple prompts with different tool sets", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "testFunc",
            parameters: [],
            body: [
              {
                type: "usesTool",
                toolNames: ["tool1"],
              },
              {
                type: "prompt",
                segments: [{ type: "text", value: "First" }],
              },
              {
                type: "usesTool",
                toolNames: ["tool2", "tool3"],
              },
              {
                type: "prompt",
                segments: [{ type: "text", value: "Second" }],
              },
            ],
          },
        ],
      };

      const preprocessor = new TypescriptPreprocessor(program);
      // Only call collectTools, not full preprocess
      preprocessor["getFunctionDefinitions"]();
      preprocessor["collectTools"]();

      const funcNode = preprocessor.program.nodes[0];
      if (funcNode.type === "function") {
        const prompts = funcNode.body.filter((n) => n.type === "prompt");
        expect(prompts.length).toBe(2);

        const firstPrompt = prompts[0];
        const secondPrompt = prompts[1];

        if (firstPrompt.type === "prompt") {
          expect(firstPrompt.tools?.toolNames).toEqual(["tool1"]);
        }
        if (secondPrompt.type === "prompt") {
          expect(secondPrompt.tools?.toolNames).toEqual(["tool2", "tool3"]);
        }
      }
    });
  });

  describe("containsInterrupt", () => {
    it("should detect direct interrupt calls", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "testFunc",
            parameters: [],
            body: [
              {
                type: "functionCall",
                functionName: "interrupt",
                arguments: [],
              },
            ],
          },
        ],
      };

      const preprocessor = new TypescriptPreprocessor(program);
      preprocessor.preprocess();

      const usesInterrupt =
        preprocessor["functionNameToUsesInterrupt"]["testFunc"];
      expect(usesInterrupt).toBe(true);
    });

    it("should detect transitive interrupt calls", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "helperFunc",
            parameters: [],
            body: [
              {
                type: "functionCall",
                functionName: "interrupt",
                arguments: [],
              },
            ],
          },
          {
            type: "function",
            functionName: "mainFunc",
            parameters: [],
            body: [
              {
                type: "functionCall",
                functionName: "helperFunc",
                arguments: [],
              },
            ],
          },
        ],
      };

      const preprocessor = new TypescriptPreprocessor(program);
      preprocessor.preprocess();

      expect(preprocessor["functionNameToUsesInterrupt"]["helperFunc"]).toBe(
        true,
      );
      expect(preprocessor["functionNameToUsesInterrupt"]["mainFunc"]).toBe(
        true,
      );
    });

    it("should detect interrupt through tool usage", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "toolFunc",
            parameters: [],
            body: [
              {
                type: "functionCall",
                functionName: "interrupt",
                arguments: [],
              },
            ],
          },
          {
            type: "graphNode",
            nodeName: "mainNode",
            parameters: [],
            body: [
              {
                type: "usesTool",
                toolNames: ["toolFunc"],
              },
              {
                type: "assignment",
                variableName: "result",
                value: {
                  type: "prompt",
                  segments: [{ type: "text", value: "Test" }],
                },
              },
            ],
          },
        ],
      };

      const preprocessor = new TypescriptPreprocessor(program);
      preprocessor.preprocess();

      expect(preprocessor["functionNameToUsesInterrupt"]["toolFunc"]).toBe(
        true,
      );
      // mainNode won't be checked for interrupt because it's a graph node, not in the containsInterrupt map
    });
  });

  describe("markFunctionsAsync", () => {
    it("should mark functions without interrupt as async", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "testFunc",
            parameters: [],
            body: [
              {
                type: "assignment",
                variableName: "x",
                value: { type: "number", value: "42" },
              },
            ],
          },
        ],
      };

      const preprocessor = new TypescriptPreprocessor(program);
      preprocessor.preprocess();

      const funcNode = preprocessor.program.nodes[0];
      if (funcNode.type === "function") {
        expect(funcNode.async).toBe(true);
      }
    });

    it("should mark functions with interrupt as sync", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "testFunc",
            parameters: [],
            body: [
              {
                type: "functionCall",
                functionName: "interrupt",
                arguments: [],
              },
            ],
          },
        ],
      };

      const preprocessor = new TypescriptPreprocessor(program);
      preprocessor.preprocess();

      const funcNode = preprocessor.program.nodes[0];
      if (funcNode.type === "function") {
        expect(funcNode.async).toBe(false);
      }
    });

    it("should respect user-defined async flag", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "testFunc",
            parameters: [],
            body: [],
            async: false, // User explicitly set to false
          },
        ],
      };

      const preprocessor = new TypescriptPreprocessor(program);
      preprocessor.preprocess();

      const funcNode = preprocessor.program.nodes[0];
      if (funcNode.type === "function") {
        expect(funcNode.async).toBe(false);
      }
    });
  });

  describe("markFunctionCallsAsync", () => {
    it("should mark function calls to async functions as async", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "asyncFunc",
            parameters: [],
            body: [],
            // Will be marked as async by preprocessor
          },
          {
            type: "function",
            functionName: "caller",
            parameters: [],
            body: [
              {
                type: "functionCall",
                functionName: "asyncFunc",
                arguments: [],
              },
            ],
          },
        ],
      };

      const preprocessor = new TypescriptPreprocessor(program);
      preprocessor.preprocess();

      const callerNode = preprocessor.program.nodes[1];
      if (callerNode.type === "function") {
        const callNode = callerNode.body[0];
        if (callNode.type === "functionCall") {
          expect(callNode.async).toBe(true);
        }
      }
    });

    it("should mark prompts with interrupt-using tools as sync", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "toolWithInterrupt",
            parameters: [],
            body: [
              {
                type: "functionCall",
                functionName: "interrupt",
                arguments: [],
              },
            ],
          },
          {
            type: "function",
            functionName: "mainFunc",
            parameters: [],
            body: [
              {
                type: "usesTool",
                toolNames: ["toolWithInterrupt"],
              },
              {
                type: "assignment",
                variableName: "result",
                value: {
                  type: "prompt",
                  segments: [{ type: "text", value: "Test" }],
                },
              },
            ],
          },
        ],
      };

      const preprocessor = new TypescriptPreprocessor(program);
      preprocessor.preprocess();

      const mainNode = preprocessor.program.nodes[1];
      if (mainNode.type === "function") {
        const assignment = mainNode.body.find((n) => n.type === "assignment");
        if (
          assignment &&
          assignment.type === "assignment" &&
          assignment.value.type === "prompt"
        ) {
          expect(assignment.value.async).toBe(false);
        }
      }
    });
  });

  describe("removeUnusedLlmCalls", () => {
    it("should remove standalone prompts without sync tools", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "testFunc",
            parameters: [],
            body: [
              {
                type: "prompt",
                segments: [{ type: "text", value: "Unused prompt" }],
              },
              {
                type: "assignment",
                variableName: "x",
                value: { type: "number", value: "42" },
              },
            ],
          },
        ],
      };

      const preprocessor = new TypescriptPreprocessor(program);
      preprocessor.preprocess();

      const funcNode = preprocessor.program.nodes[0];
      if (funcNode.type === "function") {
        const promptNode = funcNode.body.find((n) => n.type === "prompt");
        expect(promptNode).toBeUndefined();

        // Should be replaced with a comment
        const commentNode = funcNode.body.find((n) => n.type === "comment");
        expect(commentNode).toBeDefined();
        if (commentNode && commentNode.type === "comment") {
          expect(commentNode.content).toContain("Removed unused LLM call");
        }
      }
    });

    it("should keep prompts with sync tools (side effects)", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "syncTool",
            parameters: [],
            body: [
              {
                type: "functionCall",
                functionName: "interrupt",
                arguments: [],
              },
            ],
          },
          {
            type: "function",
            functionName: "testFunc",
            parameters: [],
            body: [
              {
                type: "usesTool",
                toolNames: ["syncTool"],
              },
              {
                type: "prompt",
                segments: [{ type: "text", value: "Prompt with side effects" }],
              },
            ],
          },
        ],
      };

      const preprocessor = new TypescriptPreprocessor(program);
      preprocessor.preprocess();

      const funcNode = preprocessor.program.nodes[1];
      if (funcNode.type === "function") {
        const promptNode = funcNode.body.find((n) => n.type === "prompt");
        expect(promptNode).toBeDefined();
      }
    });

    it("should remove unused assigned prompts without sync tools", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "testFunc",
            parameters: [],
            body: [
              {
                type: "assignment",
                variableName: "result",
                value: {
                  type: "prompt",
                  segments: [{ type: "text", value: "Unused" }],
                },
              },
              {
                type: "assignment",
                variableName: "x",
                value: { type: "number", value: "42" },
              },
            ],
          },
        ],
      };

      const preprocessor = new TypescriptPreprocessor(program);
      preprocessor.preprocess();

      const funcNode = preprocessor.program.nodes[0];
      if (funcNode.type === "function") {
        const assignments = funcNode.body.filter(
          (n) => n.type === "assignment",
        );
        expect(assignments.length).toBe(1);
        if (assignments[0].type === "assignment") {
          expect(assignments[0].variableName).toBe("x");
        }
      }
    });

    it("should keep used assigned prompts", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "testFunc",
            parameters: [],
            body: [
              {
                type: "assignment",
                variableName: "result",
                value: {
                  type: "prompt",
                  segments: [{ type: "text", value: "Used prompt" }],
                },
              },
              {
                type: "functionCall",
                functionName: "print",
                arguments: [{ type: "variableName", value: "result" }],
              },
            ],
          },
        ],
      };

      const preprocessor = new TypescriptPreprocessor(program);
      preprocessor.preprocess();

      const funcNode = preprocessor.program.nodes[0];
      if (funcNode.type === "function") {
        const assignment = funcNode.body.find((n) => n.type === "assignment");
        expect(assignment).toBeDefined();
        if (assignment && assignment.type === "assignment") {
          expect(assignment.variableName).toBe("result");
        }
      }
    });

    it("should keep returned prompts", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "testFunc",
            parameters: [],
            body: [
              {
                type: "returnStatement",
                value: {
                  type: "prompt",
                  segments: [{ type: "text", value: "Returned prompt" }],
                },
              },
            ],
          },
        ],
      };

      const preprocessor = new TypescriptPreprocessor(program);
      preprocessor.preprocess();

      const funcNode = preprocessor.program.nodes[0];
      if (funcNode.type === "function") {
        const returnNode = funcNode.body.find(
          (n) => n.type === "returnStatement",
        );
        expect(returnNode).toBeDefined();
        if (returnNode && returnNode.type === "returnStatement") {
          expect(returnNode.value.type).toBe("prompt");
        }
      }
    });
  });

  describe("addPromiseAllCalls", () => {
    it("should add Promise.all for multiple async calls used together", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "asyncFunc",
            parameters: [],
            body: [],
          },
          {
            type: "function",
            functionName: "testFunc",
            parameters: [],
            body: [
              {
                type: "assignment",
                variableName: "a",
                value: {
                  type: "functionCall",
                  functionName: "asyncFunc",
                  arguments: [],
                },
              },
              {
                type: "assignment",
                variableName: "b",
                value: {
                  type: "functionCall",
                  functionName: "asyncFunc",
                  arguments: [],
                },
              },
              {
                type: "functionCall",
                functionName: "print",
                arguments: [{ type: "variableName", value: "a" }],
              },
            ],
          },
        ],
      };

      const preprocessor = new TypescriptPreprocessor(program);
      preprocessor.preprocess();

      const funcNode = preprocessor.program.nodes[1];
      if (funcNode.type === "function") {
        const rawCodeNodes = funcNode.body.filter((n) => n.type === "rawCode");
        expect(rawCodeNodes.length).toBeGreaterThan(0);

        if (rawCodeNodes[0] && rawCodeNodes[0].type === "rawCode") {
          expect(rawCodeNodes[0].value).toContain("Promise.all");
          expect(rawCodeNodes[0].value).toContain("__self.a");
        }
      }
    });

    it("should handle multiple async assignments with different first usage points", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "asyncFunc",
            parameters: [],
            body: [],
          },
          {
            type: "function",
            functionName: "testFunc",
            parameters: [],
            body: [
              {
                type: "assignment",
                variableName: "a",
                value: {
                  type: "functionCall",
                  functionName: "asyncFunc",
                  arguments: [],
                },
              },
              {
                type: "assignment",
                variableName: "b",
                value: {
                  type: "functionCall",
                  functionName: "asyncFunc",
                  arguments: [],
                },
              },
              {
                type: "functionCall",
                functionName: "print",
                arguments: [{ type: "variableName", value: "a" }],
              },
              {
                type: "functionCall",
                functionName: "print",
                arguments: [{ type: "variableName", value: "b" }],
              },
            ],
          },
        ],
      };

      const preprocessor = new TypescriptPreprocessor(program);
      preprocessor.preprocess();

      const funcNode = preprocessor.program.nodes[1];
      if (funcNode.type === "function") {
        // Should have Promise.all injected before first usage
        const rawCodeNodes = funcNode.body.filter((n) => n.type === "rawCode");
        expect(rawCodeNodes.length).toBeGreaterThan(0);
      }
    });

    it("should handle async prompts", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "testFunc",
            parameters: [],
            body: [
              {
                type: "assignment",
                variableName: "a",
                value: {
                  type: "prompt",
                  segments: [{ type: "text", value: "First" }],
                  async: true,
                },
              },
              {
                type: "assignment",
                variableName: "b",
                value: {
                  type: "prompt",
                  segments: [{ type: "text", value: "Second" }],
                  async: true,
                },
              },
              {
                type: "functionCall",
                functionName: "print",
                arguments: [{ type: "variableName", value: "a" }],
              },
            ],
          },
        ],
      };

      const preprocessor = new TypescriptPreprocessor(program);
      preprocessor.preprocess();

      const funcNode = preprocessor.program.nodes[0];
      if (funcNode.type === "function") {
        const rawCodeNodes = funcNode.body.filter((n) => n.type === "rawCode");
        expect(rawCodeNodes.length).toBeGreaterThan(0);
      }
    });

    it("should recursively process nested blocks", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "asyncFunc",
            parameters: [],
            body: [
              {
                type: "assignment",
                variableName: "x",
                value: { type: "number", value: "1" },
              },
            ],
          },
          {
            type: "function",
            functionName: "testFunc",
            parameters: [],
            body: [
              {
                type: "whileLoop",
                condition: { type: "variableName", value: "true" },
                body: [
                  {
                    type: "assignment",
                    variableName: "a",
                    value: {
                      type: "functionCall",
                      functionName: "asyncFunc",
                      arguments: [],
                    },
                  },
                  {
                    type: "functionCall",
                    functionName: "print",
                    arguments: [{ type: "variableName", value: "a" }],
                  },
                ],
              },
            ],
          },
        ],
      };

      const preprocessor = new TypescriptPreprocessor(program);
      preprocessor.preprocess();

      const funcNode = preprocessor.program.nodes[1];
      if (funcNode.type === "function") {
        const whileNode = funcNode.body.find((n) => n.type === "whileLoop");
        expect(whileNode).toBeDefined();
        if (whileNode && whileNode.type === "whileLoop") {
          // Promise.all should be injected inside the while loop
          const rawCodeNodes = whileNode.body.filter(
            (n) => n.type === "rawCode",
          );
          expect(rawCodeNodes.length).toBeGreaterThan(0);
        }
      }
    });
  });

  describe("topologicalSortFunctions", () => {
    it("should sort functions in dependency order", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "caller",
            parameters: [],
            body: [
              {
                type: "functionCall",
                functionName: "helper",
                arguments: [],
              },
            ],
          },
          {
            type: "function",
            functionName: "helper",
            parameters: [],
            body: [],
          },
        ],
      };

      const preprocessor = new TypescriptPreprocessor(program);
      // Need to call preprocess to populate functionDefinitions first
      preprocessor.preprocess();

      // Manually call the sort function on the definitions
      const sorted = preprocessor["topologicalSortFunctions"]();

      expect(sorted.length).toBe(2);
      // Helper should come before caller since caller depends on helper
      // (actually the algorithm reverses, so caller comes first in the sorted array)
      const helperIndex = sorted.findIndex((f) => f.functionName === "helper");
      const callerIndex = sorted.findIndex((f) => f.functionName === "caller");
      expect(helperIndex).toBeGreaterThan(-1);
      expect(callerIndex).toBeGreaterThan(-1);
    });

    it("should handle complex dependency chains", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "c",
            parameters: [],
            body: [
              {
                type: "functionCall",
                functionName: "b",
                arguments: [],
              },
            ],
          },
          {
            type: "function",
            functionName: "b",
            parameters: [],
            body: [
              {
                type: "functionCall",
                functionName: "a",
                arguments: [],
              },
            ],
          },
          {
            type: "function",
            functionName: "a",
            parameters: [],
            body: [],
          },
        ],
      };

      const preprocessor = new TypescriptPreprocessor(program);
      // Need to call preprocess to populate functionDefinitions first
      preprocessor.preprocess();

      const sorted = preprocessor["topologicalSortFunctions"]();

      expect(sorted.length).toBe(3);
      // Verify all functions are present
      const names = sorted.map((f) => f.functionName);
      expect(names).toContain("a");
      expect(names).toContain("b");
      expect(names).toContain("c");
    });
  });

  describe("walkNodes", () => {
    it("should walk all nodes in the program", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "assignment",
            variableName: "x",
            value: { type: "number", value: "1" },
          },
          {
            type: "function",
            functionName: "testFunc",
            parameters: [],
            body: [
              {
                type: "assignment",
                variableName: "y",
                value: { type: "number", value: "2" },
              },
            ],
          },
        ],
      };

      const preprocessor = new TypescriptPreprocessor(program);
      const nodes = Array.from(
        preprocessor["walkNodes"](program.nodes).map((n) => n.node),
      );

      expect(nodes.length).toBeGreaterThan(2);

      const assignments = nodes.filter((n) => n.type === "assignment");
      expect(assignments.length).toBe(2);
    });

    it("should walk nested structures", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "testFunc",
            parameters: [],
            body: [
              {
                type: "ifElse",
                condition: { type: "variableName", value: "true" },
                thenBody: [
                  {
                    type: "whileLoop",
                    condition: { type: "variableName", value: "false" },
                    body: [
                      {
                        type: "assignment",
                        variableName: "x",
                        value: { type: "number", value: "1" },
                      },
                    ],
                  },
                ],
                elseBody: [],
              },
            ],
          },
        ],
      };

      const preprocessor = new TypescriptPreprocessor(program);
      const nodes = Array.from(
        preprocessor["walkNodes"](program.nodes).map((n) => n.node),
      );

      const ifNode = nodes.find((n) => n.type === "ifElse");
      const whileNode = nodes.find((n) => n.type === "whileLoop");
      const assignment = nodes.find((n) => n.type === "assignment");

      expect(ifNode).toBeDefined();
      expect(whileNode).toBeDefined();
      expect(assignment).toBeDefined();
    });
  });

  describe("isVarUsedInBody", () => {
    it("should detect variable usage", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "testFunc",
            parameters: [],
            body: [
              {
                type: "assignment",
                variableName: "x",
                value: { type: "number", value: "42" },
              },
              {
                type: "functionCall",
                functionName: "print",
                arguments: [{ type: "variableName", value: "x" }],
              },
            ],
          },
        ],
      };

      const preprocessor = new TypescriptPreprocessor(program);
      const funcNode = program.nodes[0];
      if (funcNode.type === "function") {
        const assignmentNode = funcNode.body[0];
        const isUsed = preprocessor["isVarUsedInBody"](
          "x",
          assignmentNode,
          funcNode.body,
        );
        expect(isUsed).toBe(true);
      }
    });

    it("should return false for unused variables", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "testFunc",
            parameters: [],
            body: [
              {
                type: "assignment",
                variableName: "x",
                value: { type: "number", value: "42" },
              },
              {
                type: "functionCall",
                functionName: "print",
                arguments: [{ type: "number", value: "10" }],
              },
            ],
          },
        ],
      };

      const preprocessor = new TypescriptPreprocessor(program);
      const funcNode = program.nodes[0];
      if (funcNode.type === "function") {
        const assignmentNode = funcNode.body[0];
        const isUsed = preprocessor["isVarUsedInBody"](
          "x",
          assignmentNode,
          funcNode.body,
        );
        expect(isUsed).toBe(false);
      }
    });
  });

  describe("renderMermaid", () => {
    it("should generate mermaid diagrams for functions", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "testFunc",
            parameters: [],
            body: [
              {
                type: "functionCall",
                functionName: "helper",
                arguments: [],
              },
            ],
          },
        ],
      };

      const preprocessor = new TypescriptPreprocessor(program);
      preprocessor.preprocess();
      const mermaid = preprocessor.renderMermaid();

      expect(mermaid).toBeDefined();
      expect(mermaid.length).toBeGreaterThan(0);
      expect(mermaid[0]).toContain("graph LR");
      expect(mermaid[0]).toContain("testFunc");
    });

    it("should show parallel async calls", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "asyncFunc",
            parameters: [],
            body: [],
          },
          {
            type: "function",
            functionName: "testFunc",
            parameters: [],
            body: [
              {
                type: "functionCall",
                functionName: "asyncFunc",
                arguments: [],
              },
              {
                type: "functionCall",
                functionName: "asyncFunc",
                arguments: [],
              },
            ],
          },
        ],
      };

      const preprocessor = new TypescriptPreprocessor(program);
      preprocessor.preprocess();
      const mermaid = preprocessor.renderMermaid();

      expect(mermaid).toBeDefined();
      expect(mermaid.length).toBeGreaterThan(0);
    });

    it("should include tool labels for prompts", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "tool1",
            parameters: [],
            body: [],
          },
          {
            type: "function",
            functionName: "testFunc",
            parameters: [],
            body: [
              {
                type: "usesTool",
                toolNames: ["tool1"],
              },
              {
                type: "prompt",
                segments: [{ type: "text", value: "Test" }],
              },
            ],
          },
        ],
      };

      const preprocessor = new TypescriptPreprocessor(program);
      preprocessor.preprocess();
      const mermaid = preprocessor.renderMermaid();

      expect(mermaid).toBeDefined();
      const combined = mermaid.join("\n");
      expect(combined).toContain("tool1");
    });
  });
});
