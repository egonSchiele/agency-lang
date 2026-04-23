import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import pkg from "../../package.json" with { type: "json" };
import { handleMcpMessage } from "./server.js";

let tmpDir: string;
let agencyFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-mcp-server-test-"));
  agencyFile = path.join(tmpDir, "main.agency");
  fs.writeFileSync(
    agencyFile,
    [
      "node main() {",
      '  const response = llm("Say hello to world")',
      "  print(response)",
      "}",
      "",
    ].join("\n"),
  );
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("handleMcpMessage", () => {
  it("responds to initialize", () => {
    const response = handleMcpMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test" } },
    });

    expect(response?.result?.protocolVersion).toBe("2025-06-18");
    expect(response?.result?.capabilities?.tools?.listChanged).toBe(false);
    expect(response?.result?.serverInfo?.version).toBe(pkg.version);
  });

  it("lists Agency MCP tools", () => {
    const response = handleMcpMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });

    expect(response?.result?.tools.some((tool: any) => tool.name === "agency_diagnostics")).toBe(true);
    expect(response?.result?.tools.some((tool: any) => tool.name === "agency_definition")).toBe(true);
  });

  it("runs diagnostics tool", () => {
    const response = handleMcpMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "agency_diagnostics",
        arguments: { file_path: agencyFile },
      },
    });

    expect(response?.result?.isError).toBe(false);
    expect(response?.result?.structuredContent?.diagnostics).toEqual([]);
  });

  it("runs document symbols tool", () => {
    const response = handleMcpMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "agency_document_symbols",
        arguments: { file_path: agencyFile },
      },
    });

    expect(response?.result?.structuredContent?.symbols).toHaveLength(1);
    expect(response?.result?.structuredContent?.symbols[0].name).toBe("main");
  });

  it("runs formatting tool", () => {
    const response = handleMcpMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "agency_format",
        arguments: {
          file_path: agencyFile,
          text: "node main(){print(1)}\n",
        },
      },
    });

    expect(response?.result?.structuredContent?.changed).toBe(true);
    expect(response?.result?.structuredContent?.formatted).toContain("node main()");
  });

  it("resolves imported symbol hover and definition", () => {
    const helperFile = path.join(tmpDir, "helpers.agency");
    fs.writeFileSync(
      helperFile,
      [
        "export def greet(name: string): string {",
        "  return name",
        "}",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      agencyFile,
      [
        'import { greet as hello } from "./helpers.agency"',
        "",
        "node main() {",
        '  print(hello("world"))',
        "}",
        "",
      ].join("\n"),
    );

    const hoverResponse = handleMcpMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "agency_hover",
        arguments: { file_path: agencyFile, line: 3, character: 8 },
      },
    });
    const definitionResponse = handleMcpMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "agency_definition",
        arguments: { file_path: agencyFile, line: 3, character: 8 },
      },
    });

    expect(hoverResponse?.result?.structuredContent?.hover).toContain("Imported from `./helpers.agency` as `greet`");
    expect(definitionResponse?.result?.structuredContent?.definition?.file_path).toBe(helperFile);
  });

  it("returns an MCP error response for invalid json input", () => {
    const response = handleMcpMessage({
      jsonrpc: "1.0",
      id: 1,
      method: "initialize",
    });

    expect(response?.error?.code).toBe(-32600);
  });
});
