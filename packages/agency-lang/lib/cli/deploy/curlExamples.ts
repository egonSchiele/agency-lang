// Ready-to-run curl commands for a deployed agent. Pure: manifest in, command
// strings out. Uses a `$KEY` placeholder — never the real API key.

import type { ServeManifest } from "../statelog/serveClient.js";

export type CurlExample = { label: string; command: string };

const AUTH = `-H "Authorization: Bearer $KEY"`;
const JSON_HEADER = `-H "Content-Type: application/json"`;

/**
 * One curl per endpoint: the manifest (GET), each node (POST), and each function
 * (POST) — every call body templated from that endpoint's parameters.
 */
export function curlExamples(serveBase: string, manifest: ServeManifest): CurlExample[] {
  const manifestExample: CurlExample = {
    label: "manifest",
    command: `curl -s ${AUTH} "${serveBase}/list"`,
  };

  const nodeExamples = manifest.nodes.map((node) => ({
    label: `node ${node.name}`,
    command: post(`${serveBase}/node/${node.name}`, bodyTemplate(node.parameters)),
  }));

  const functionExamples = manifest.functions.map((fn) => ({
    label: `function ${fn.name}`,
    command: post(`${serveBase}/function/${fn.name}`, bodyTemplate(fn.parameters)),
  }));

  return [manifestExample, ...nodeExamples, ...functionExamples];
}

function post(url: string, body: string): string {
  return `curl -s -X POST "${url}" ${AUTH} ${JSON_HEADER} -d '${body}'`;
}

/** A JSON body with one placeholder per parameter, or `{}` when there are none. */
function bodyTemplate(parameters: string[]): string {
  const fields = parameters.map((name) => `"${name}":"…"`).join(",");
  return `{${fields}}`;
}
