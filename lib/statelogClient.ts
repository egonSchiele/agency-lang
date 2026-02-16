import { nanoid } from "nanoid";
import { JSONEdge } from "./types.js";

export class StatelogClient {
  private host: string;
  private debugMode: boolean;
  private traceId: string;
  private apiKey: string;
  private projectId: string;

  constructor(config: {
    host: string;
    apiKey: string;
    projectId: string;
    traceId?: string;
    debugMode?: boolean;
  }) {
    const { host, apiKey, projectId, traceId, debugMode } = config;
    this.host = host;
    this.apiKey = apiKey;
    this.projectId = projectId;
    this.debugMode = debugMode || false;
    this.traceId = traceId || nanoid();
    if (this.debugMode) {
      console.log(
        `Statelog client initialized with host: ${host} and traceId: ${this.traceId}`,
        { config },
      );
    }

    if (!this.apiKey) {
      throw new Error("API key is required for StatelogClient");
    }
  }

  toJSON() {
    return {
      traceId: this.traceId,
      projectId: this.projectId,
      host: this.host,
      debugMode: this.debugMode,
    };
  }

  async debug(message: string, data: any): Promise<void> {
    await this.post({
      type: "debug",
      message: message,
      data,
    });
  }

  async graph({
    nodes,
    edges,
    startNode,
  }: {
    nodes: string[];
    edges: Record<string, JSONEdge>;
    startNode?: string;
  }): Promise<void> {
    await this.post({
      type: "graph",
      nodes,
      edges,
      startNode,
    });
  }

  async enterNode({
    nodeId,
    data,
  }: {
    nodeId: string;
    data: any;
  }): Promise<void> {
    await this.post({
      type: "enterNode",
      nodeId,
      data,
    });
  }

  async exitNode({
    nodeId,
    data,
    timeTaken,
  }: {
    nodeId: string;
    data: any;
    timeTaken?: number;
  }): Promise<void> {
    await this.post({
      type: "exitNode",
      nodeId,
      data,
      timeTaken,
    });
  }

  async beforeHook({
    nodeId,
    startData,
    endData,
    timeTaken,
  }: {
    nodeId: string;
    startData: any;
    endData: any;
    timeTaken?: number;
  }): Promise<void> {
    await this.post({
      type: "beforeHook",
      nodeId,
      startData,
      endData,
      timeTaken,
    });
  }

  async afterHook({
    nodeId,
    startData,
    endData,
    timeTaken,
  }: {
    nodeId: string;
    startData: any;
    endData: any;
    timeTaken?: number;
  }): Promise<void> {
    await this.post({
      type: "afterHook",
      nodeId,
      startData,
      endData,
      timeTaken,
    });
  }

  async followEdge({
    fromNodeId,
    toNodeId,
    isConditionalEdge,
    data,
  }: {
    fromNodeId: string;
    toNodeId: string;
    isConditionalEdge: boolean;
    data: any;
  }): Promise<void> {
    await this.post({
      type: "followEdge",
      edgeId: `${fromNodeId}->${toNodeId}`,
      fromNodeId,
      toNodeId,
      isConditionalEdge,
      data,
    });
  }

  async promptCompletion({
    messages,
    completion,
    model,
    timeTaken,
    tools,
    responseFormat,
  }: {
    messages: any[];
    completion: any;
    model?: string;
    timeTaken?: number;
    tools?: {
      name: string;
      description?: string;
      schema: any;
    }[];
    responseFormat?: any;
  }): Promise<void> {
    await this.post({
      type: "promptCompletion",
      messages,
      completion,
      model,
      timeTaken,
      tools,
      responseFormat,
    });
  }

  async toolCall({
    toolName,
    args,
    output,
    model,
    timeTaken,
  }: {
    toolName: string;
    args: any;
    output: any;
    model?: string;
    timeTaken?: number;
  }): Promise<void> {
    await this.post({
      type: "toolCall",
      toolName,
      args,
      output,
      model,
      timeTaken,
    });
  }

  async post(body: Record<string, any>): Promise<void> {
    if (!this.host) {
      return;
    }

    const postBody = JSON.stringify({
      trace_id: this.traceId,
      project_id: this.projectId,
      data: { ...body, timestamp: new Date().toISOString() },
    });

    if (this.host.toLowerCase() === "stdout") {
      console.log(postBody);
      return;
    }

    try {
      const fullUrl = new URL("/api/logs", this.host);
      const url = fullUrl.toString();

      await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: postBody,
      }).catch((err) => {
        if (this.debugMode) console.error("Failed to send statelog:", err);
      });
    } catch (err) {
      if (this.debugMode)
        console.error("Error sending log in statelog client:", err, {
          host: this.host,
        });
    }
  }
}
