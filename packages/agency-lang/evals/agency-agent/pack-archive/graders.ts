import { agentGraders } from "../lib/checks.js";

export default agentGraders([
  { name: "roundtrip-sample", mustPass: true },
  { name: "caps-sample", mustPass: true },
  { name: "roundtrip-hidden" },
]);
