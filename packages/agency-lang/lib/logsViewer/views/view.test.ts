import { describe, expect, it } from "vitest";

import { lines } from "../../tui/builders.js";
import { makeViewStack, type View } from "./view.js";

function fakeView(viewName: View["viewName"]): View {
  return {
    viewName,
    handleKey: () => ({ kind: "none" }),
    render: () => lines([viewName]),
    setData: () => {},
    helpLines: () => [viewName],
    notify: () => {},
    setFollowIndicator: () => {},
  };
}

describe("makeViewStack", () => {
  it("push and active track the top; all() lists bottom-first", () => {
    const tree = fakeView("tree");
    const stack = makeViewStack(tree);
    const flame = fakeView("flame");
    stack.push(flame);
    expect(stack.active()).toBe(flame);
    expect(stack.all().map((v) => v.viewName)).toEqual(["tree", "flame"]);
  });

  it("popTo unwinds multiple levels to an existing view", () => {
    const stack = makeViewStack(fakeView("tree"));
    stack.push(fakeView("flame"));
    stack.push(fakeView("byName"));
    stack.push(fakeView("detail"));
    expect(stack.popTo("tree")).toBe(true);
    expect(stack.active().viewName).toBe("tree");
    expect(stack.all()).toHaveLength(1);
  });

  it("popTo returns false when the view is absent, leaving the stack alone", () => {
    const stack = makeViewStack(fakeView("tree"));
    stack.push(fakeView("flame"));
    expect(stack.popTo("byName")).toBe(false);
    expect(stack.all().map((v) => v.viewName)).toEqual(["tree", "flame"]);
  });

  it("pop never removes the bottom view", () => {
    const stack = makeViewStack(fakeView("tree"));
    stack.push(fakeView("flame"));
    stack.pop();
    stack.pop();
    stack.pop();
    expect(stack.all().map((v) => v.viewName)).toEqual(["tree"]);
  });
});
