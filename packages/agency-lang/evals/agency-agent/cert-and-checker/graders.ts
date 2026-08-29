import { agentGraders } from "../lib/checks.js";

export default agentGraders([
  { name: "key-and-cert", mustPass: true },
  { name: "verification-file" },
  { name: "checker-runs-clean", mustPass: true },
]);
