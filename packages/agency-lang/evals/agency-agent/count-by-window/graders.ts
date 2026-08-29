import { agentGraders } from "../lib/checks.js";

export default agentGraders([
  { name: "summary-exact", mustPass: true },
  { name: "header-and-order", weight: 0.5 },
]);
