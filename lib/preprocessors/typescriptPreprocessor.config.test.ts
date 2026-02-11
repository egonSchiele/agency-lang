import { describe, it, expect } from "vitest";
import { TypescriptPreprocessor } from "./typescriptPreprocessor.js";
import { AgencyProgram, AgencyNode } from "../types.js";
import { AgencyConfig } from "../config.js";

describe("TypescriptPreprocessor Config", () => {
  describe("excludeNodeTypes", () => {
    it("should filter out comment nodes", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          { type: "comment", content: "This is a comment" },
          {
            type: "assignment",
            variableName: "x",
            value: { type: "number", value: "42" }
          },
          { type: "comment", content: "Another comment" },
        ],
      };

      const config: AgencyConfig = {
        excludeNodeTypes: ["comment"],
      };

      const preprocessor = new TypescriptPreprocessor(program, config);
      const result = preprocessor.preprocess();

      expect(result.nodes.length).toBe(1);
      expect(result.nodes[0].type).toBe("assignment");
    });

    it("should filter out multiple node types", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          { type: "comment", content: "Comment" },
          { type: "typeHint", variableName: "x", variableType: { type: "primitiveType", value: "string" } },
          {
            type: "assignment",
            variableName: "x",
            value: { type: "number", value: "42" }
          },
          { type: "newLine" },
        ],
      };

      const config: AgencyConfig = {
        excludeNodeTypes: ["comment", "typeHint", "newLine"],
      };

      const preprocessor = new TypescriptPreprocessor(program, config);
      const result = preprocessor.preprocess();

      expect(result.nodes.length).toBe(1);
      expect(result.nodes[0].type).toBe("assignment");
    });

    it("should filter nodes within function bodies", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "testFunc",
            parameters: [],
            body: [
              { type: "comment", content: "Function comment" },
              {
                type: "assignment",
                variableName: "x",
                value: { type: "number", value: "1" }
              },
            ],
          },
        ],
      };

      const config: AgencyConfig = {
        excludeNodeTypes: ["comment"],
      };

      const preprocessor = new TypescriptPreprocessor(program, config);
      const result = preprocessor.preprocess();

      expect(result.nodes.length).toBe(1);
      if (result.nodes[0].type === "function") {
        expect(result.nodes[0].body.length).toBe(1);
        expect(result.nodes[0].body[0].type).toBe("assignment");
      }
    });
  });

  describe("excludeBuiltinFunctions", () => {
    it("should filter out print function calls", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "functionCall",
            functionName: "print",
            arguments: [{ type: "string", segments: [{ type: "text", value: "Hello" }] }],
          },
          {
            type: "assignment",
            variableName: "x",
            value: { type: "number", value: "42" },
          },
        ],
      };

      const config: AgencyConfig = {
        excludeBuiltinFunctions: ["print"],
      };

      const preprocessor = new TypescriptPreprocessor(program, config);
      const result = preprocessor.preprocess();

      expect(result.nodes.length).toBe(1);
      expect(result.nodes[0].type).toBe("assignment");
    });

    it("should filter out multiple builtin functions", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "functionCall",
            functionName: "print",
            arguments: [],
          },
          {
            type: "functionCall",
            functionName: "write",
            arguments: [],
          },
          {
            type: "assignment",
            variableName: "x",
            value: { type: "number", value: "42" },
          },
        ],
      };

      const config: AgencyConfig = {
        excludeBuiltinFunctions: ["print", "write"],
      };

      const preprocessor = new TypescriptPreprocessor(program, config);
      const result = preprocessor.preprocess();

      expect(result.nodes.length).toBe(1);
      expect(result.nodes[0].type).toBe("assignment");
    });

    it("should filter assignments to excluded builtin function calls", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "assignment",
            variableName: "content",
            value: {
              type: "functionCall",
              functionName: "read",
              arguments: [{ type: "string", segments: [{ type: "text", value: "file.txt" }] }],
            },
          },
          {
            type: "assignment",
            variableName: "x",
            value: { type: "number", value: "42" },
          },
        ],
      };

      const config: AgencyConfig = {
        excludeBuiltinFunctions: ["read"],
      };

      const preprocessor = new TypescriptPreprocessor(program, config);
      const result = preprocessor.preprocess();

      expect(result.nodes.length).toBe(1);
      expect(result.nodes[0].type).toBe("assignment");
      if (result.nodes[0].type === "assignment") {
        expect(result.nodes[0].variableName).toBe("x");
      }
    });
  });

  describe("allowedFetchDomains", () => {
    it("should allow fetch to whitelisted domain", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "functionCall",
            functionName: "fetch",
            arguments: [
              { type: "string", segments: [{ type: "text", value: "https://api.example.com/data" }] },
            ],
          },
        ],
      };

      const config: AgencyConfig = {
        allowedFetchDomains: ["api.example.com"],
      };

      const preprocessor = new TypescriptPreprocessor(program, config);
      expect(() => preprocessor.preprocess()).not.toThrow();
    });

    it("should throw error for non-whitelisted domain", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "functionCall",
            functionName: "fetch",
            arguments: [
              { type: "string", segments: [{ type: "text", value: "https://malicious.com/data" }] },
            ],
          },
        ],
      };

      const config: AgencyConfig = {
        allowedFetchDomains: ["api.example.com"],
      };

      const preprocessor = new TypescriptPreprocessor(program, config);
      expect(() => preprocessor.preprocess()).toThrow(/not allowed/);
    });
  });

  describe("disallowedFetchDomains", () => {
    it("should allow fetch to non-blacklisted domain", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "functionCall",
            functionName: "fetch",
            arguments: [
              { type: "string", segments: [{ type: "text", value: "https://api.example.com/data" }] },
            ],
          },
        ],
      };

      const config: AgencyConfig = {
        disallowedFetchDomains: ["malicious.com"],
      };

      const preprocessor = new TypescriptPreprocessor(program, config);
      expect(() => preprocessor.preprocess()).not.toThrow();
    });

    it("should throw error for blacklisted domain", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "functionCall",
            functionName: "fetch",
            arguments: [
              { type: "string", segments: [{ type: "text", value: "https://malicious.com/data" }] },
            ],
          },
        ],
      };

      const config: AgencyConfig = {
        disallowedFetchDomains: ["malicious.com"],
      };

      const preprocessor = new TypescriptPreprocessor(program, config);
      expect(() => preprocessor.preprocess()).toThrow(/disallowed/);
    });
  });

  describe("combined allowed and disallowed domains", () => {
    it("should take intersection of allowed and disallowed domains", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "functionCall",
            functionName: "fetch",
            arguments: [
              { type: "string", segments: [{ type: "text", value: "https://api.example.com/data" }] },
            ],
          },
        ],
      };

      const config: AgencyConfig = {
        allowedFetchDomains: ["api.example.com", "api.test.com"],
        disallowedFetchDomains: ["api.example.com"],
      };

      const preprocessor = new TypescriptPreprocessor(program, config);
      // api.example.com is in allowed but also in disallowed, so it should be blocked
      expect(() => preprocessor.preprocess()).toThrow(/not allowed/);
    });

    it("should allow domain in allowed but not in disallowed", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "functionCall",
            functionName: "fetch",
            arguments: [
              { type: "string", segments: [{ type: "text", value: "https://api.test.com/data" }] },
            ],
          },
        ],
      };

      const config: AgencyConfig = {
        allowedFetchDomains: ["api.example.com", "api.test.com"],
        disallowedFetchDomains: ["api.example.com"],
      };

      const preprocessor = new TypescriptPreprocessor(program, config);
      expect(() => preprocessor.preprocess()).not.toThrow();
    });
  });

  describe("fetchJSON and fetchJson", () => {
    it("should validate fetchJSON calls", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "functionCall",
            functionName: "fetchJSON",
            arguments: [
              { type: "string", segments: [{ type: "text", value: "https://malicious.com/api" }] },
            ],
          },
        ],
      };

      const config: AgencyConfig = {
        disallowedFetchDomains: ["malicious.com"],
      };

      const preprocessor = new TypescriptPreprocessor(program, config);
      expect(() => preprocessor.preprocess()).toThrow(/disallowed/);
    });

    it("should validate fetchJson calls", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "functionCall",
            functionName: "fetchJson",
            arguments: [
              { type: "string", segments: [{ type: "text", value: "https://malicious.com/api" }] },
            ],
          },
        ],
      };

      const config: AgencyConfig = {
        disallowedFetchDomains: ["malicious.com"],
      };

      const preprocessor = new TypescriptPreprocessor(program, config);
      expect(() => preprocessor.preprocess()).toThrow(/disallowed/);
    });
  });
});
