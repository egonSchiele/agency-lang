import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeAdapter } from "./adapters.js";
import { parseCases } from "./data.js";

afterEach(() => vi.unstubAllEnvs());

describe("real smoltalk HTTP adapters", () => {
  it("batches decision questions and translates text logprobs without leaking gold", async () => {
    const received: {
      url: string;
      body: { questions: Record<string, unknown>; messages: unknown[]; top_logprobs: number };
    }[] = [];
    const server = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
      }
      const parsed = JSON.parse(body);
      received.push({ url: req.url!, body: parsed });
      res.setHeader("content-type", "application/json");
      if (req.url === "/v1/systemone") {
        res.end(
          JSON.stringify({
            model: "laya-test",
            answers: Object.fromEntries(
              Object.keys(parsed.questions).map((key) => [key, { type: "noul", noul: 0.8 }]),
            ),
            usage: { input_tokens: 12, output_tokens: 0 },
          }),
        );
      } else {
        res.end(
          JSON.stringify({
            id: "test",
            object: "chat.completion",
            model: "gpt-4o-mini",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "B" },
                finish_reason: "stop",
                logprobs: {
                  content: [
                    {
                      token: "B",
                      logprob: Math.log(0.8),
                      top_logprobs: [
                        { token: "A", logprob: Math.log(0.2) },
                        { token: "B", logprob: Math.log(0.8) },
                      ],
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 },
          }),
        );
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    vi.stubEnv("OPENAI_API_KEY", "test");
    const item = parseCases(
      JSON.stringify({
        id: "one",
        state: "SAMPLE STATE",
        questions: {
          a: { type: "noul", instructions: "Question A" },
          b: { type: "noul", instructions: "Question B" },
        },
        gold: { a: { label: "true" }, b: { label: "false" } },
      }),
    )[0];
    try {
      const decision = await makeAdapter({
        backend: "laya",
        model: "laya",
        baseUrl: host,
        batchSize: 2,
        timeoutMs: 1000,
      })(item);
      expect(decision.requests).toBe(1);
      expect(Object.keys(decision.predictions)).toEqual(["a", "b"]);
      expect(received[0].body).toEqual({
        model: "laya",
        state: item.state,
        questions: item.questions,
      });
      const text = await makeAdapter({
        backend: "logprobs",
        model: "gpt-4o-mini",
        baseUrl: `${host}/v1`,
        batchSize: 1,
        timeoutMs: 1000,
      })(item);
      expect(text.requests).toBe(2);
      expect(text.predictions.a.probabilities?.true).toBeCloseTo(0.8);
      expect(received[1].url).toBe("/v1/chat/completions");
      expect(received[1].body.top_logprobs).toBe(20);
      expect(received[1].body.messages).toHaveLength(2);
      expect(JSON.stringify(received[1].body)).not.toContain('"gold"');
      expect(received[2].body.messages).toHaveLength(2);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("does not retry HTTP failures hidden inside the OpenAI SDK", async () => {
    let requests = 0;
    const server = createServer((_req, res) => {
      requests++;
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "rate limit" } }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    vi.stubEnv("OPENAI_API_KEY", "test");
    try {
      const adapter = makeAdapter({
        backend: "logprobs",
        model: "gpt-4o-mini",
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
        batchSize: 1,
        timeoutMs: 1000,
      });
      const item = parseCases(
        JSON.stringify({
          id: "x",
          state: "x",
          questions: { q: { type: "noul", instructions: "x?" } },
          gold: { q: { label: "true" } },
        }),
      )[0];
      await expect(adapter(item)).rejects.toThrow(/rate limit/i);
      expect(requests).toBe(1);
      await expect(adapter(item)).rejects.toMatchObject({
        partial: {
          requests: 1,
          calls: [
            {
              questionIds: ["q"],
              elapsedMs: expect.any(Number),
              error: expect.stringMatching(/rate limit/i),
            },
          ],
        },
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
