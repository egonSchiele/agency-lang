import { BaseClient, promptResult, success } from "smoltalk";

class EchoClient extends BaseClient {
  async textSync() {
    return success(promptResult({ output: "ECHO_OK", toolCalls: [] }));
  }
}

export function register({ registerProvider }) {
  registerProvider("echo", EchoClient);
}
