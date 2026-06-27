import { BaseClient } from "smoltalk";
class FakeLlama extends BaseClient {
  async textSync() { return { success: true, value: { output: "x", toolCalls: [] } }; }
}
export function register({ registerProvider }) { registerProvider("llama-cpp", FakeLlama); }
export async function resolveModel(target) { return "RESOLVED:" + target; }
