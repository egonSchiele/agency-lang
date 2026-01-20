import graph from "./foo.js";
const finalState = await graph.run("greet", { messages: [], data: {} });
console.log(finalState);