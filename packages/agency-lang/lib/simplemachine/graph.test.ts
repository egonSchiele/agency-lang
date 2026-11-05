import { describe, expect, it } from "vitest";
import type { StatelogClient } from "@/statelogClient.js";
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

describe("SimpleMachine.run and endsRun", () => {
  /** A client that records the `endsRun` of each `exitNode` and ignores the
   *  other events. */
  function recordingClient(): { client: StatelogClient; endsRun: (boolean | undefined)[] } {
    const endsRun: (boolean | undefined)[] = [];
    const ignore = () => undefined;
    const client = {
      graph: ignore,
      enterNode: ignore,
      followEdge: ignore,
      startSpan: ignore,
      endSpan: ignore,
      exitNode: (event: { endsRun?: boolean }) => {
        endsRun.push(event.endsRun);
      },
    } as unknown as StatelogClient;
    return { client, endsRun };
  }

  it("marks the last exitNode when the caller logs the value in agentEnd", async () => {
    const { client, endsRun } = recordingClient();
    await machine().run(
      "alone",
      { value: 1 },
      { statelogClient: client, finalValueInAgentEnd: true },
    );
    expect(endsRun).toEqual([true]);
  });

  it("leaves the last exitNode whole for a caller that logs no agentEnd", async () => {
    const { client, endsRun } = recordingClient();
    await machine().run("alone", { value: 1 }, { statelogClient: client });
    expect(endsRun).toEqual([false]);
  });
});
