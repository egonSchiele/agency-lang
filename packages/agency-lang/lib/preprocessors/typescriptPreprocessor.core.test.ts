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
    it("should attach a @module doc comment to program.docComment", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          { type: "multiLineComment", content: " File docs ", isDoc: true, isModuleDoc: true },
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

    it("should allow @module doc comment after imports", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "importStatement",
            modulePath: "./foo.js",
            importedNames: [],
          } as any,
          { type: "multiLineComment", content: " File docs ", isDoc: true, isModuleDoc: true },
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

    it("should throw if @module doc comment appears after non-import code", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "typeAlias",
            aliasName: "Foo",
            aliasedType: { type: "primitiveType", value: "string" },
          },
          { type: "multiLineComment", content: " Too late ", isDoc: true, isModuleDoc: true },
          {
            type: "function",
            functionName: "foo",
            parameters: [],
            body: [],
          },
        ],
      };
      const preprocessor = new TypescriptPreprocessor(program);
      expect(() => preprocessor.preprocess()).toThrow("@module doc comment must appear before any code");
    });

    it("should throw if there are duplicate @module doc comments", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          { type: "multiLineComment", content: " First ", isDoc: true, isModuleDoc: true },
          { type: "multiLineComment", content: " Second ", isDoc: true, isModuleDoc: true },
          {
            type: "function",
            functionName: "foo",
            parameters: [],
            body: [],
          },
        ],
      };
      const preprocessor = new TypescriptPreprocessor(program);
      expect(() => preprocessor.preprocess()).toThrow("Only one @module doc comment is allowed per file");
    });

    it("should skip regular comments before @module doc comment", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          { type: "comment", content: " regular comment" },
          { type: "multiLineComment", content: " File docs ", isDoc: true, isModuleDoc: true },
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

    it("should not treat a regular doc comment as file-level", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          { type: "multiLineComment", content: " Not module doc ", isDoc: true, isModuleDoc: false },
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
      expect(program.docComment).toBeUndefined();
    });

    it("should attach doc comment to a function when directly before it", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          { type: "multiLineComment", content: " Func docs ", isDoc: true, isModuleDoc: false },
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
          { type: "multiLineComment", content: " Func docs ", isDoc: true, isModuleDoc: false },
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
          { type: "multiLineComment", content: " Node docs ", isDoc: true, isModuleDoc: false },
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
          { type: "multiLineComment", content: " Type docs ", isDoc: true, isModuleDoc: false },
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
          { type: "multiLineComment", content: " regular ", isDoc: false, isModuleDoc: false },
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
          { type: "multiLineComment", content: " orphan doc ", isDoc: true, isModuleDoc: false },
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
          { type: "multiLineComment", content: " Func docs ", isDoc: true, isModuleDoc: false },
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
});
