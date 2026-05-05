import { describe, it, expect } from "vitest";
import { TypescriptPreprocessor } from "./typescriptPreprocessor.js";
import { AgencyProgram } from "../types.js";
import { walkNodes } from "@/utils/node.js";

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


  describe.skip("containsInterrupt", () => {
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

  });

  describe.skip("markFunctionsAsync", () => {
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

  });

  describe.skip("markFunctionCallsAsync", () => {
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

  });

  // TODO: removeUnusedLlmCalls is disabled pending rewrite for llm() as FunctionCall
  describe.skip("removeUnusedLlmCalls", () => {
    it("should remove standalone llm calls without sync tools", () => {
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
                functionName: "llm",
                arguments: [{ type: "string", segments: [{ type: "text", value: "Unused prompt" }] }],
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
        const llmCall = funcNode.body.find(
          (n) => n.type === "functionCall" && n.functionName === "llm",
        );
        expect(llmCall).toBeUndefined();

        // Should be replaced with a comment
        const commentNode = funcNode.body.find((n) => n.type === "comment");
        expect(commentNode).toBeDefined();
        if (commentNode && commentNode.type === "comment") {
          expect(commentNode.content).toContain("Removed unused LLM call");
        }
      }
    });

    it.skip("should keep llm calls with sync tools (side effects)", () => {
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
                type: "functionCall",
                functionName: "llm",
                arguments: [{ type: "string", segments: [{ type: "text", value: "Prompt with side effects" }] }],
              },
            ],
          },
        ],
      };

      const preprocessor = new TypescriptPreprocessor(program);
      preprocessor.preprocess();

      const funcNode = preprocessor.program.nodes[1];
      if (funcNode.type === "function") {
        const llmCall = funcNode.body.find(
          (n) => n.type === "functionCall" && n.functionName === "llm",
        );
        expect(llmCall).toBeDefined();
      }
    });

    it("should remove unused assigned llm calls without sync tools", () => {
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
                  type: "functionCall",
                  functionName: "llm",
                  arguments: [{ type: "string", segments: [{ type: "text", value: "Unused" }] }],
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

    it("should keep used assigned llm calls", () => {
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
                  type: "functionCall",
                  functionName: "llm",
                  arguments: [{ type: "string", segments: [{ type: "text", value: "Used prompt" }] }],
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

    it("should keep returned llm calls", () => {
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
                  type: "functionCall",
                  functionName: "llm",
                  arguments: [{ type: "string", segments: [{ type: "text", value: "Returned prompt" }] }],
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
          expect(returnNode.value?.type).toBe("functionCall");
        }
      }
    });
  });

  describe.skip("addPromiseAllCalls", () => {
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
          expect(rawCodeNodes[0].value).toContain("awaitPending");
          expect(rawCodeNodes[0].value).toContain("__self.__pendingKey_a");
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

    it("should handle async llm calls", () => {
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
                  type: "functionCall",
                  functionName: "llm",
                  arguments: [{ type: "string", segments: [{ type: "text", value: "First" }] }],
                  async: true,
                },
              },
              {
                type: "assignment",
                variableName: "b",
                value: {
                  type: "functionCall",
                  functionName: "llm",
                  arguments: [{ type: "string", segments: [{ type: "text", value: "Second" }] }],
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
      const nodes = Array.from(walkNodes(program.nodes).map((n) => n.node));

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
      const nodes = Array.from(walkNodes(program.nodes).map((n) => n.node));

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

    it("should include tool labels for llm calls", () => {
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
                type: "functionCall",
                functionName: "llm",
                arguments: [{ type: "string", segments: [{ type: "text", value: "Test" }] }],
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

  describe("attachDocComments", () => {
    it("should attach a file-level doc comment to program.docComment", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          { type: "multiLineComment", content: " File docs ", isDoc: true },
          {
            type: "importStatement",
            modulePath: "./foo.js",
            importedNames: [],
          } as any,
          {
            type: "function",
            functionName: "foo",
            parameters: [],
            body: [],
          },
        ],
      };
      const preprocessor = new TypescriptPreprocessor(program);
      preprocessor.preprocess();
      expect(program.docComment).toBeDefined();
      expect(program.docComment!.content).toBe(" File docs ");
      // Should be removed from nodes
      expect(program.nodes.every((n) => n.type !== "multiLineComment")).toBe(true);
    });

    it("should skip regular comments before file-level doc comment", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          { type: "comment", content: " regular comment" },
          { type: "multiLineComment", content: " File docs ", isDoc: true },
          {
            type: "importStatement",
            modulePath: "./foo.js",
            importedNames: [],
          } as any,
          {
            type: "function",
            functionName: "foo",
            parameters: [],
            body: [],
          },
        ],
      };
      const preprocessor = new TypescriptPreprocessor(program);
      preprocessor.preprocess();
      expect(program.docComment).toBeDefined();
      expect(program.docComment!.content).toBe(" File docs ");
    });

    it("should attach doc comment to a function when directly before it", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          { type: "multiLineComment", content: " Func docs ", isDoc: true },
          {
            type: "function",
            functionName: "foo",
            parameters: [],
            body: [],
          },
        ],
      };
      const preprocessor = new TypescriptPreprocessor(program);
      preprocessor.preprocess();
      // Doc comment directly before a declaration attaches to the declaration, not file-level
      expect(program.docComment).toBeUndefined();
      const fn = program.nodes.find((n) => n.type === "function") as any;
      expect(fn.docComment).toBeDefined();
      expect(fn.docComment.content).toBe(" Func docs ");
    });

    it("should attach doc comment to a function after an import", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "importStatement",
            modulePath: "./foo.js",
            importedNames: [],
          } as any,
          { type: "multiLineComment", content: " Func docs ", isDoc: true },
          {
            type: "function",
            functionName: "foo",
            parameters: [],
            body: [],
          },
        ],
      };
      const preprocessor = new TypescriptPreprocessor(program);
      preprocessor.preprocess();
      expect(program.docComment).toBeUndefined();
      const fn = program.nodes.find((n) => n.type === "function") as any;
      expect(fn.docComment).toBeDefined();
      expect(fn.docComment.content).toBe(" Func docs ");
    });

    it("should attach doc comment to a node", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "importStatement",
            modulePath: "./foo.js",
            importedNames: [],
          } as any,
          { type: "multiLineComment", content: " Node docs ", isDoc: true },
          {
            type: "graphNode",
            nodeName: "main",
            parameters: [],
            body: [],
          },
        ],
      };
      const preprocessor = new TypescriptPreprocessor(program);
      preprocessor.preprocess();
      const node = program.nodes.find((n) => n.type === "graphNode") as any;
      expect(node.docComment).toBeDefined();
      expect(node.docComment.content).toBe(" Node docs ");
    });

    it("should attach doc comment to a type alias", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "importStatement",
            modulePath: "./foo.js",
            importedNames: [],
          } as any,
          { type: "multiLineComment", content: " Type docs ", isDoc: true },
          {
            type: "typeAlias",
            aliasName: "Foo",
            aliasedType: { type: "primitiveType", value: "string" },
          },
        ],
      };
      const preprocessor = new TypescriptPreprocessor(program);
      preprocessor.preprocess();
      const alias = program.nodes.find((n) => n.type === "typeAlias") as any;
      expect(alias.docComment).toBeDefined();
      expect(alias.docComment.content).toBe(" Type docs ");
    });

    it("should not attach non-doc multi-line comments", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          { type: "multiLineComment", content: " regular ", isDoc: false },
          {
            type: "function",
            functionName: "foo",
            parameters: [],
            body: [],
          },
        ],
      };
      const preprocessor = new TypescriptPreprocessor(program);
      preprocessor.preprocess();
      expect(program.docComment).toBeUndefined();
      const fn = program.nodes.find((n) => n.type === "function") as any;
      expect(fn.docComment).toBeUndefined();
    });

    it("should leave unattached doc comments in statement list", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "importStatement",
            modulePath: "./foo.js",
            importedNames: [],
          } as any,
          { type: "multiLineComment", content: " orphan doc ", isDoc: true },
          {
            type: "importStatement",
            modulePath: "./bar.js",
            importedNames: [],
          } as any,
        ],
      };
      const preprocessor = new TypescriptPreprocessor(program);
      preprocessor.preprocess();
      expect(program.docComment).toBeUndefined();
      const comments = program.nodes.filter((n) => n.type === "multiLineComment");
      expect(comments.length).toBe(1);
    });

    it("should attach doc comments with newlines between comment and declaration", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "importStatement",
            modulePath: "./foo.js",
            importedNames: [],
          } as any,
          { type: "multiLineComment", content: " Func docs ", isDoc: true },
          { type: "newLine" },
          {
            type: "function",
            functionName: "foo",
            parameters: [],
            body: [],
          },
        ],
      };
      const preprocessor = new TypescriptPreprocessor(program);
      preprocessor.preprocess();
      const fn = program.nodes.find((n) => n.type === "function") as any;
      expect(fn.docComment).toBeDefined();
      expect(fn.docComment.content).toBe(" Func docs ");
    });
  });

  describe("closure analysis for nested functions", () => {
    it("marks variables from enclosing function as captured", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "outer",
            parameters: [
              { type: "functionParameter", name: "x" },
            ],
            body: [
              {
                type: "assignment",
                variableName: "y",
                declKind: "const",
                value: { type: "number", value: "5" },
              },
              {
                type: "function",
                functionName: "inner",
                parameters: [
                  { type: "functionParameter", name: "z" },
                ],
                body: [
                  {
                    type: "variableName",
                    value: "x",
                  },
                  {
                    type: "variableName",
                    value: "y",
                  },
                  {
                    type: "variableName",
                    value: "z",
                  },
                ],
              },
            ],
          },
        ],
      };
      const preprocessor = new TypescriptPreprocessor(program);
      preprocessor.preprocess();

      const outer = program.nodes[0] as any;
      const inner = outer.body.find((n: any) => n.type === "function");
      expect(inner).toBeDefined();

      // x and y should be captured from outer
      expect(inner.capturedVariables).toBeDefined();
      expect(inner.capturedVariables).toHaveLength(2);
      const capturedNames = inner.capturedVariables.map((v: any) => v.name);
      expect(capturedNames).toContain("x");
      expect(capturedNames).toContain("y");

      // x is an arg, y is a local in outer
      const xCapture = inner.capturedVariables.find((v: any) => v.name === "x");
      expect(xCapture.sourceType).toBe("args");
      const yCapture = inner.capturedVariables.find((v: any) => v.name === "y");
      expect(yCapture.sourceType).toBe("local");

      // z is inner's own param — should be scoped as "args", not captured
      const zNode = inner.body.find((n: any) => n.type === "variableName" && n.value === "z");
      expect(zNode.scope).toBe("args");

      // x and y in inner's body should be scoped as "captured"
      const xNode = inner.body.find((n: any) => n.type === "variableName" && n.value === "x");
      expect(xNode.scope).toBe("captured");
      const yNode = inner.body.find((n: any) => n.type === "variableName" && n.value === "y");
      expect(yNode.scope).toBe("captured");
    });

    it("inner function with no captures has no capturedVariables", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "outer",
            parameters: [],
            body: [
              {
                type: "function",
                functionName: "inner",
                parameters: [
                  { type: "functionParameter", name: "x" },
                ],
                body: [
                  { type: "variableName", value: "x" },
                ],
              },
            ],
          },
        ],
      };
      const preprocessor = new TypescriptPreprocessor(program);
      preprocessor.preprocess();

      const outer = program.nodes[0] as any;
      const inner = outer.body.find((n: any) => n.type === "function");
      expect(inner.capturedVariables).toBeUndefined();
    });

    it("globals are not captured — they keep global scope", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "assignment",
            variableName: "g",
            declKind: "const",
            value: { type: "number", value: "1" },
          },
          {
            type: "function",
            functionName: "outer",
            parameters: [],
            body: [
              {
                type: "function",
                functionName: "inner",
                parameters: [],
                body: [
                  { type: "variableName", value: "g" },
                ],
              },
            ],
          },
        ],
      };
      const preprocessor = new TypescriptPreprocessor(program);
      preprocessor.preprocess();

      const outer = program.nodes.find((n: any) => n.type === "function") as any;
      const inner = outer.body.find((n: any) => n.type === "function");
      const gNode = inner.body.find((n: any) => n.type === "variableName" && n.value === "g");
      expect(gNode.scope).toBe("global");
      expect(inner.capturedVariables).toBeUndefined();
    });

    it("detects self-referencing inner function", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "outer",
            parameters: [],
            body: [
              {
                type: "function",
                functionName: "fib",
                parameters: [
                  { type: "functionParameter", name: "n" },
                ],
                body: [
                  { type: "variableName", value: "fib" },
                  { type: "variableName", value: "n" },
                ],
              },
            ],
          },
        ],
      };
      const preprocessor = new TypescriptPreprocessor(program);
      preprocessor.preprocess();

      const outer = program.nodes[0] as any;
      const fib = outer.body.find((n: any) => n.type === "function");
      expect(fib.selfReferencing).toBe(true);
      // Self-reference should not appear in capturedVariables
      expect(fib.capturedVariables ?? []).toHaveLength(0);
    });

    it("nested def inside a node body captures node args", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "graphNode",
            nodeName: "main",
            parameters: [
              { type: "functionParameter", name: "name" },
            ],
            body: [
              {
                type: "function",
                functionName: "greet",
                parameters: [],
                body: [
                  { type: "variableName", value: "name" },
                ],
              },
            ],
          },
        ],
      };
      const preprocessor = new TypescriptPreprocessor(program);
      preprocessor.preprocess();

      const main = program.nodes[0] as any;
      const greet = main.body.find((n: any) => n.type === "function");
      expect(greet.capturedVariables).toHaveLength(1);
      expect(greet.capturedVariables[0].name).toBe("name");
      expect(greet.capturedVariables[0].sourceType).toBe("args");
    });
  });
});
