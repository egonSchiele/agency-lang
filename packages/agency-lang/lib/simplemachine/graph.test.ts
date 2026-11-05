import { describe, expect, it } from "vitest";
import { goToNode, SimpleMachine } from "./graph.js";

type State = { value: number };

function machine(): SimpleMachine<State> {
  const graph = new SimpleMachine<State>();
  graph.node("alone", async (state) => state);
  graph.node("chooser", async (state) => state);
  graph.node("next", async (state) => state);
  graph.conditionalEdge("chooser", ["next"]);
  return graph;
}

describe("SimpleMachine.endsRunAt", () => {
  it("ends the run at a node with no edge", () => {
    expect(machine().endsRunAt("alone", { value: 1 })).toBe(true);
  });

  it("ends the run at a node with a conditional edge that returns normally", () => {
    expect(machine().endsRunAt("chooser", { value: 1 })).toBe(true);
  });

  it("does not end the run at a node that goes to another node", () => {
    expect(machine().endsRunAt("chooser", goToNode("next", { value: 1 }))).toBe(false);
  });

  it("does not end the run at a node with a regular edge", () => {
    const graph = machine();
    graph.edge("alone", "next");
    expect(graph.endsRunAt("alone", { value: 1 })).toBe(false);
  });
});
