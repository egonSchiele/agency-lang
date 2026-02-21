import { describe, it, expect } from "vitest";
import { TypescriptPreprocessor } from "./typescriptPreprocessor.js";
import { AgencyProgram, AgencyNode } from "@/types.js";

describe("TypescriptPreprocessor - Promise.all handling", () => {
  describe("_addPromiseAllCalls", () => {
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
                      type: "prompt",
                      segments: [
                        {
                          type: "text",
                          value: "Write a story",
                        },
                      ],
                      async: true,
                      isStreaming: true,
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
                      type: "prompt",
                      segments: [
                        {
                          type: "text",
                          value: "Get fibonacci numbers",
                        },
                      ],
                      async: true,
                      isStreaming: true,
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
          (node) => node.type === "assignment" && node.value.type === "prompt",
        );
        expect(promptNodes.length).toBe(2);
        for (const promptNode of promptNodes) {
          // @ts-ignore
          expect(promptNode.value.async).toBe(false);
        }
      }
    });

    it("should add Promise.all when variable is defined in TimeBlock and used in parent body", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "graphNode",
            nodeName: "main",
            parameters: [],
            body: [
              {
                type: "timeBlock",
                body: [
                  {
                    type: "assignment",
                    variableName: "result",
                    typeHint: { type: "primitiveType", value: "string" },
                    value: {
                      type: "prompt",
                      segments: [
                        {
                          type: "text",
                          value: "Get result",
                        },
                      ],
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
                    value: "result",
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
        expect(promiseAllNode.value).toContain("Promise.all");
        expect(promiseAllNode.value).toContain("__self.result");
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
                  type: "prompt",
                  segments: [
                    {
                      type: "text",
                      value: "Write a story",
                    },
                  ],
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
        expect(promiseAllNode.value).toContain("Promise.all");
        expect(promiseAllNode.value).toContain("__self.story");
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
                      type: "prompt",
                      segments: [
                        {
                          type: "text",
                          value: "Inner prompt",
                        },
                      ],
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

    // ── Parallel thread: markFunctionCallsAsync tests ──

    it("should mark prompts inside parallel block as async (not forced sync)", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "foo",
            parameters: [],
            body: [
              {
                type: "messageThread",
                threadType: "parallel",
                body: [
                  {
                    type: "assignment",
                    variableName: "a",
                    typeHint: { type: "primitiveType", value: "number" },
                    value: {
                      type: "prompt",
                      segments: [{ type: "text", value: "What is 2+2?" }],
                    },
                  },
                  {
                    type: "assignment",
                    variableName: "b",
                    typeHint: { type: "primitiveType", value: "number" },
                    value: {
                      type: "prompt",
                      segments: [{ type: "text", value: "What is 3+3?" }],
                    },
                  },
                ],
              },
            ],
          },
        ],
      };

      const preprocessor = new TypescriptPreprocessor(program);
      const result = preprocessor.preprocess();

      const funcNode = result.nodes[0];
      if (funcNode.type !== "function") return;

      const parallelNode = funcNode.body.find(
        (n) => n.type === "messageThread",
      );
      expect(parallelNode).toBeDefined();
      if (parallelNode?.type !== "messageThread") return;

      const assignments = parallelNode.body.filter(
        (n) => n.type === "assignment" && n.value.type === "prompt",
      );
      expect(assignments.length).toBe(2);
      for (const a of assignments) {
        if (a.type === "assignment" && a.value.type === "prompt") {
          expect(a.value.async).toBe(true);
        }
      }
    });

    it("should force prompts in thread block sync even when parallel sibling exists", () => {
      // parallel inside thread: the thread-level prompt should be sync,
      // the parallel-level prompts should be async
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "foo",
            parameters: [],
            body: [
              {
                type: "messageThread",
                threadType: "thread",
                body: [
                  {
                    type: "assignment",
                    variableName: "sync_res",
                    typeHint: { type: "primitiveType", value: "string" },
                    value: {
                      type: "prompt",
                      segments: [{ type: "text", value: "sync prompt" }],
                    },
                  },
                  {
                    type: "messageThread",
                    threadType: "parallel",
                    body: [
                      {
                        type: "assignment",
                        variableName: "async_a",
                        typeHint: { type: "primitiveType", value: "number" },
                        value: {
                          type: "prompt",
                          segments: [{ type: "text", value: "parallel a" }],
                        },
                      },
                      {
                        type: "assignment",
                        variableName: "async_b",
                        typeHint: { type: "primitiveType", value: "number" },
                        value: {
                          type: "prompt",
                          segments: [{ type: "text", value: "parallel b" }],
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      };

      const preprocessor = new TypescriptPreprocessor(program);
      const result = preprocessor.preprocess();

      const funcNode = result.nodes[0];
      if (funcNode.type !== "function") return;

      const threadNode = funcNode.body.find((n) => n.type === "messageThread");
      if (threadNode?.type !== "messageThread") return;

      // Thread-level prompt should be sync
      const syncAssignment = threadNode.body.find(
        (n) => n.type === "assignment" && n.variableName === "sync_res",
      );
      expect(syncAssignment).toBeDefined();
      if (syncAssignment?.type === "assignment" && syncAssignment.value.type === "prompt") {
        expect(syncAssignment.value.async).toBe(false);
      }

      // Parallel-level prompts should be async
      const parallelNode = threadNode.body.find(
        (n) => n.type === "messageThread" && n.threadType === "parallel",
      );
      if (parallelNode?.type !== "messageThread") return;
      const asyncAssignments = parallelNode.body.filter(
        (n) => n.type === "assignment" && n.value.type === "prompt",
      );
      for (const a of asyncAssignments) {
        if (a.type === "assignment" && a.value.type === "prompt") {
          expect(a.value.async).toBe(true);
        }
      }
    });

    it("should force prompts sync in thread nested inside parallel", () => {
      // thread inside parallel: the inner thread's prompt should be forced sync
      // because the closest messageThread ancestor is a "thread"
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "foo",
            parameters: [],
            body: [
              {
                type: "messageThread",
                threadType: "parallel",
                body: [
                  {
                    type: "messageThread",
                    threadType: "thread",
                    body: [
                      {
                        type: "assignment",
                        variableName: "inner",
                        typeHint: { type: "primitiveType", value: "string" },
                        value: {
                          type: "prompt",
                          segments: [{ type: "text", value: "inner prompt" }],
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      };

      const preprocessor = new TypescriptPreprocessor(program);
      const result = preprocessor.preprocess();

      const funcNode = result.nodes[0];
      if (funcNode.type !== "function") return;

      const parallelNode = funcNode.body.find((n) => n.type === "messageThread");
      if (parallelNode?.type !== "messageThread") return;

      const innerThread = parallelNode.body.find(
        (n) => n.type === "messageThread" && n.threadType === "thread",
      );
      if (innerThread?.type !== "messageThread") return;

      const assignment = innerThread.body.find(
        (n) => n.type === "assignment" && n.variableName === "inner",
      );
      if (assignment?.type === "assignment" && assignment.value.type === "prompt") {
        expect(assignment.value.async).toBe(false);
      }
    });

    it("should allow function calls containing prompts to be async inside parallel block", () => {
      // A function that contains a prompt, called inside a parallel block,
      // should NOT be forced sync (unlike in a regular thread block)
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "helper",
            parameters: [],
            body: [
              {
                type: "assignment",
                variableName: "x",
                typeHint: { type: "primitiveType", value: "string" },
                value: {
                  type: "prompt",
                  segments: [{ type: "text", value: "helper prompt" }],
                },
              },
            ],
          },
          {
            type: "function",
            functionName: "foo",
            parameters: [],
            body: [
              {
                type: "messageThread",
                threadType: "parallel",
                body: [
                  {
                    type: "assignment",
                    variableName: "result",
                    value: {
                      type: "functionCall",
                      functionName: "helper",
                      arguments: [],
                    },
                  },
                ],
              },
            ],
          },
        ],
      };

      const preprocessor = new TypescriptPreprocessor(program);
      const result = preprocessor.preprocess();

      const fooNode = result.nodes.find(
        (n) => n.type === "function" && n.functionName === "foo",
      );
      if (fooNode?.type !== "function") return;

      const parallelNode = fooNode.body.find((n) => n.type === "messageThread");
      if (parallelNode?.type !== "messageThread") return;

      const assignment = parallelNode.body.find(
        (n) => n.type === "assignment" && n.variableName === "result",
      );
      // In a regular thread, this would be forced sync (async=false).
      // In a parallel block, it should remain async (true) or at least not forced sync.
      if (assignment?.type === "assignment" && assignment.value.type === "functionCall") {
        expect(assignment.value.async).not.toBe(false);
      }
    });

    // ── Parallel thread: Promise.all insertion tests ──

    it("should append Promise.all at end of parallel block for async prompts", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "foo",
            parameters: [],
            body: [
              {
                type: "messageThread",
                threadType: "parallel",
                body: [
                  {
                    type: "assignment",
                    variableName: "a",
                    typeHint: { type: "primitiveType", value: "number" },
                    value: {
                      type: "prompt",
                      segments: [{ type: "text", value: "What is 2+2?" }],
                    },
                  },
                  {
                    type: "assignment",
                    variableName: "b",
                    typeHint: { type: "primitiveType", value: "number" },
                    value: {
                      type: "prompt",
                      segments: [{ type: "text", value: "What is 3+3?" }],
                    },
                  },
                ],
              },
            ],
          },
        ],
      };

      const preprocessor = new TypescriptPreprocessor(program);
      const result = preprocessor.preprocess();

      const funcNode = result.nodes[0];
      if (funcNode.type !== "function") return;

      const parallelNode = funcNode.body.find(
        (n) => n.type === "messageThread",
      );
      if (parallelNode?.type !== "messageThread") return;

      // The last node in the parallel body should be a rawCode Promise.all
      const lastNode = parallelNode.body[parallelNode.body.length - 1];
      expect(lastNode.type).toBe("rawCode");
      if (lastNode.type === "rawCode") {
        expect(lastNode.value).toContain("Promise.all");
        expect(lastNode.value).toContain("__self.a");
        expect(lastNode.value).toContain("__self.b");
      }
    });

    it("should NOT append Promise.all in parallel block with no async prompts", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "foo",
            parameters: [],
            body: [
              {
                type: "messageThread",
                threadType: "parallel",
                body: [
                  {
                    type: "assignment",
                    variableName: "x",
                    value: {
                      type: "number",
                      value: "42",
                    },
                  },
                ],
              },
            ],
          },
        ],
      };

      const preprocessor = new TypescriptPreprocessor(program);
      const result = preprocessor.preprocess();

      const funcNode = result.nodes[0];
      if (funcNode.type !== "function") return;

      const parallelNode = funcNode.body.find(
        (n) => n.type === "messageThread",
      );
      if (parallelNode?.type !== "messageThread") return;

      const rawCodeNodes = parallelNode.body.filter(
        (n) => n.type === "rawCode",
      );
      expect(rawCodeNodes.length).toBe(0);
    });

    it("should collect all async vars in parallel Promise.all", () => {
      // Three async prompts in a parallel block — all three should be in the Promise.all
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "foo",
            parameters: [],
            body: [
              {
                type: "messageThread",
                threadType: "parallel",
                body: [
                  {
                    type: "assignment",
                    variableName: "x",
                    typeHint: { type: "primitiveType", value: "number" },
                    value: {
                      type: "prompt",
                      segments: [{ type: "text", value: "prompt x" }],
                    },
                  },
                  {
                    type: "assignment",
                    variableName: "y",
                    typeHint: { type: "primitiveType", value: "number" },
                    value: {
                      type: "prompt",
                      segments: [{ type: "text", value: "prompt y" }],
                    },
                  },
                  {
                    type: "assignment",
                    variableName: "z",
                    typeHint: { type: "primitiveType", value: "number" },
                    value: {
                      type: "prompt",
                      segments: [{ type: "text", value: "prompt z" }],
                    },
                  },
                ],
              },
            ],
          },
        ],
      };

      const preprocessor = new TypescriptPreprocessor(program);
      const result = preprocessor.preprocess();

      const funcNode = result.nodes[0];
      if (funcNode.type !== "function") return;

      const parallelNode = funcNode.body.find(
        (n) => n.type === "messageThread",
      );
      if (parallelNode?.type !== "messageThread") return;

      const lastNode = parallelNode.body[parallelNode.body.length - 1];
      expect(lastNode.type).toBe("rawCode");
      if (lastNode.type === "rawCode") {
        expect(lastNode.value).toContain("Promise.all");
        expect(lastNode.value).toContain("__self.x");
        expect(lastNode.value).toContain("__self.y");
        expect(lastNode.value).toContain("__self.z");
      }
    });

    it("should have Promise.all inside parallel block and usage-based Promise.all outside", () => {
      // The parallel block appends its own Promise.all for its async vars.
      // The usage-based system also sees those vars used later and inserts
      // another Promise.all before the usage site. Both are present: the inner
      // one ensures all parallel calls complete before exiting the block,
      // the outer one is a harmless no-op (promises already resolved).
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "foo",
            parameters: [],
            body: [
              {
                type: "messageThread",
                threadType: "parallel",
                body: [
                  {
                    type: "assignment",
                    variableName: "a",
                    typeHint: { type: "primitiveType", value: "number" },
                    value: {
                      type: "prompt",
                      segments: [{ type: "text", value: "What is 2+2?" }],
                    },
                  },
                ],
              },
              {
                type: "functionCall",
                functionName: "print",
                arguments: [
                  { type: "variableName", value: "a" },
                ],
              },
            ],
          },
        ],
      };

      const preprocessor = new TypescriptPreprocessor(program);
      const result = preprocessor.preprocess();

      const funcNode = result.nodes[0];
      if (funcNode.type !== "function") return;

      // Collect all rawCode nodes with Promise.all
      const innerPromiseAll: AgencyNode[] = [];
      const outerPromiseAll: AgencyNode[] = [];

      const parallelNode = funcNode.body.find(
        (n) => n.type === "messageThread",
      );
      if (parallelNode?.type === "messageThread") {
        for (const n of parallelNode.body) {
          if (n.type === "rawCode" && n.value.includes("Promise.all")) {
            innerPromiseAll.push(n);
          }
        }
      }
      for (const n of funcNode.body) {
        if (n.type === "rawCode" && n.value.includes("Promise.all")) {
          outerPromiseAll.push(n);
        }
      }

      // Inner Promise.all inside the parallel block
      expect(innerPromiseAll.length).toBe(1);
      // Outer usage-based Promise.all before the print call
      expect(outerPromiseAll.length).toBe(1);
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
                      type: "prompt",
                      segments: [{ type: "text", value: "Get A" }],
                      async: true,
                    },
                  },
                ],
              },
              {
                type: "timeBlock",
                body: [
                  {
                    type: "assignment",
                    variableName: "b",
                    value: {
                      type: "prompt",
                      segments: [{ type: "text", value: "Get B" }],
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
        expect(promiseAllNode.value).toContain("Promise.all");
        expect(promiseAllNode.value).toContain("__self.a");
        expect(promiseAllNode.value).toContain("__self.b");
      }
    });
  });
});
