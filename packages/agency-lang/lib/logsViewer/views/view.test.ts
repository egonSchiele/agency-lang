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
    const picker = fakeView("tracePicker");
    const stack = makeViewStack();
    expect(stack.active()).toBeUndefined();
    stack.push(picker);
    const detail = fakeView("detail");
    stack.push(detail);
    expect(stack.active()).toBe(detail);
    expect(stack.all().map((v) => v.viewName)).toEqual(["tracePicker", "detail"]);
  });

  it("popTo unwinds multiple levels to an existing view", () => {
    const stack = makeViewStack();
    stack.push(fakeView("tracePicker"));
    stack.push(fakeView("occurrences"));
    stack.push(fakeView("detail"));
    expect(stack.popTo("tracePicker")).toBe(true);
    expect(stack.active()?.viewName).toBe("tracePicker");
    expect(stack.all()).toHaveLength(1);
  });

  it("popTo returns false when the view is absent, leaving the stack alone", () => {
    const stack = makeViewStack();
    stack.push(fakeView("tracePicker"));
    stack.push(fakeView("detail"));
    expect(stack.popTo("occurrences")).toBe(false);
    expect(stack.all().map((v) => v.viewName)).toEqual(["tracePicker", "detail"]);
  });

  it("pop removes the last overlay", () => {
    const stack = makeViewStack();
    stack.push(fakeView("tracePicker"));
    stack.push(fakeView("detail"));
    stack.pop();
    stack.pop();
    stack.pop();
    expect(stack.all().map((v) => v.viewName)).toEqual([]);
  });
});
