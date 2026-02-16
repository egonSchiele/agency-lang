import { nanoid } from "nanoid";
import { JSONEdge } from "./types.js";
import { failure, Result, success } from "./types/result.js";
import { mergeResults } from "smoltalk";

export type AgencyFile = {
  name: string;
  contents: string;
};

export type UploadResult = Result<{
  endpointUrls: string[];
}>;

export function mergeUploadResults(_results: UploadResult[]): UploadResult {
  const results = mergeResults(_results);
  if (!results.success) {
    return failure(results.error);
  }
  const endpointUrls = results.value.flatMap((r) => r.endpointUrls);
  return success({
    endpointUrls,
  });
}

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

  async upload({
    projectId,
    entrypoint,
    files,
  }: {
    projectId: string;
    entrypoint: string;
    files: AgencyFile[];
  }): Promise<UploadResult> {
    try {
      const fullUrl = new URL(`/api/projects/${projectId}/upload`, this.host);
      const url = fullUrl.toString();
      const postBody = JSON.stringify({ entrypoint, files });
      console.log({ entrypoint, files }, postBody);
      const result = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: postBody,
      }).catch((err) => {
        if (this.debugMode) console.error("Failed to send statelog:", err);
      });
      if (result) {
        if (!result.ok) {
          if (this.debugMode)
            console.error("Failed to upload files to statelog:", {
              result,
              url,
              files,
            });
          return failure("Failed to upload files to statelog");
        }

        return (await result.json()) as Result<{
          endpointUrls: string[];
        }>;
      }
    } catch (err) {
      if (this.debugMode)
        console.error("Error sending log in statelog client:", err, {
          host: this.host,
        });
    }
    return failure("Error uploading files to statelog");
  }

  async remoteRun({
    files,
    entrypoint,
    args,
  }: {
    files: AgencyFile[];
    entrypoint: string;
    args?: any[];
  }): Promise<Result<any>> {
    try {
      const fullUrl = new URL(`/api/run`, this.host);
      const url = fullUrl.toString();
      const body = JSON.stringify({
        files,
        entrypoint,
        args,
      });
      console.log({ entrypoint, args }, body);
      const result = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body,
      }).catch((err) => {
        if (this.debugMode) console.error("Failed to run on statelog:", err);
      });
      if (result) {
        if (!result.ok) {
          if (this.debugMode) {
            const responseBody = await result.text();
            console.error("Failed to run on statelog:", {
              result,
              url,
              body,
              responseBody,
            });
          }
          return failure("Failed to run on statelog");
        }

        return (await result.json()) as Result<{
          endpointUrls: string[];
        }>;
      }
    } catch (err) {
      if (this.debugMode)
        console.error("Error running on statelog client:", err, {
          host: this.host,
        });
    }
    return failure("Error running on statelog");
  }

  async hitServer({
    userId,
    projectId,
    filename,
    nodeName,
    body,
  }: {
    userId: string;
    projectId: string;
    filename: string;
    nodeName: string;
    body: string;
  }): Promise<Result<any>> {
    try {
      const fullUrl = new URL(
        `/run/${userId}/${projectId}/${filename}/${nodeName}`,
        this.host,
      );
      const url = fullUrl.toString();
      const result = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: body,
      }).catch((err) => {
        if (this.debugMode) console.error("Failed to run on statelog:", err);
      });
      if (result) {
        if (!result.ok) {
          if (this.debugMode) {
            const responseBody = await result.text();
            console.error("Failed to run on statelog:", {
              result,
              url,
              body,
              responseBody,
            });
          }
          return failure("Failed to run on statelog");
        }

        return (await result.json()) as Result<{
          endpointUrls: string[];
        }>;
      }
    } catch (err) {
      if (this.debugMode)
        console.error("Error running on statelog client:", err, {
          host: this.host,
        });
    }
    return failure("Error running on statelog");
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

export function getStatelogClient(config: {
  host: string;
  traceId?: string;
  projectId: string;
  debugMode?: boolean;
}): StatelogClient {
  const statelogConfig = {
    host: config.host,
    traceId: config.traceId || nanoid(),
    apiKey: process.env.STATELOG_API_KEY || "",
    projectId: config.projectId,
    debugMode: config.debugMode || false,
  };
  const client = new StatelogClient(statelogConfig);
  return client;
}
