import type { PromptResult, StreamChunk, TokenUsage, CostEstimate } from "smoltalk";
import type { Result } from "smoltalk";
import type { LLMClient, PromptConfig, ToolCall } from "./llmClient.js";

export class SimpleOpenAIClient implements LLMClient {
  private apiKey: string;
  private defaultModel: string;

  constructor(opts?: { apiKey?: string; model?: string }) {
    const apiKey = opts?.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY not found. Pass apiKey option or set OPENAI_API_KEY environment variable.");
    }
    this.apiKey = apiKey;
    this.defaultModel = opts?.model ?? "gpt-4o-mini";
  }

  async text(config: PromptConfig): Promise<Result<PromptResult>> {
    const model = config.model || this.defaultModel;
    const body = this.buildRequestBody(config, model);

    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: config.abortSignal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        return { success: false, error: `OpenAI API error (${response.status}): ${errorText}` };
      }

      const data = await response.json();
      const choice = data.choices?.[0];
      const output = choice?.message?.content || "";

      return {
        success: true,
        value: {
          output,
          toolCalls: this.extractToolCalls(choice),
          usage: this.extractUsage(data),
          cost: { inputCost: 0, outputCost: 0, totalCost: 0, currency: "USD" } as CostEstimate,
          model,
        } as PromptResult,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  }

  async *textStream(config: PromptConfig): AsyncGenerator<StreamChunk> {
    const result = await this.text(config);
    if (result.success) {
      yield { type: "done", result: result.value } as StreamChunk;
    } else {
      yield { type: "error", error: result.error } as StreamChunk;
    }
  }

  private buildRequestBody(config: PromptConfig, model: string): any {
    const messages = (config.messages || []).map((m: any) => {
      const json = typeof m.toJSON === "function" ? m.toJSON() : m;
      return {
        role: json.role,
        content: json.content,
        ...(json.tool_calls ? { tool_calls: json.tool_calls } : {}),
        ...(json.tool_call_id ? { tool_call_id: json.tool_call_id } : {}),
      };
    });

    const body: any = { model, messages };

    if (config.tools && config.tools.length > 0) {
      body.tools = config.tools.map((t: any) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description || "",
          parameters: t.inputSchema || t.schema,
        },
      }));
    }

    if (config.responseFormat) {
      body.response_format = {
        type: "json_schema",
        json_schema: {
          name: "response",
          schema: typeof config.responseFormat.jsonSchema === "function"
            ? config.responseFormat.jsonSchema()
            : config.responseFormat,
          strict: true,
        },
      };
    }

    return body;
  }

  private extractToolCalls(choice: any): ToolCall[] {
    return (choice?.message?.tool_calls || []).map((tc: any) => {
      let args: Record<string, any> = {};
      try {
        args = JSON.parse(tc.function.arguments);
      } catch {}
      return { id: tc.id, name: tc.function.name, arguments: args };
    });
  }

  private extractUsage(data: any): TokenUsage {
    if (data.usage) {
      return {
        inputTokens: data.usage.prompt_tokens || 0,
        outputTokens: data.usage.completion_tokens || 0,
        cachedInputTokens: 0,
        totalTokens: data.usage.total_tokens || 0,
      };
    }
    return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0 };
  }
}
