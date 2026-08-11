import { BaseClient } from "smoltalk";
export class LlamaCPP extends BaseClient {
  async textSync() { return { success: true, value: { output: "x", toolCalls: [] } }; }
}
export async function resolveModel(target) { return "RESOLVED:" + target; }
