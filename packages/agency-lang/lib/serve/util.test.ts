import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { parseJsonBody } from "./util.js";

/** A request the test feeds by hand, which records whether it was
 *  destroyed. */
function fakeRequest() {
  const emitter = new EventEmitter();
  const state = { destroyed: false };
  const req = {
    on: (event: string, cb: (...args: any[]) => void) => {
      emitter.on(event, cb);
    },
    destroy: () => {
      state.destroyed = true;
    },
  };
  return {
    req,
    state,
    send: (chunk: Buffer) => emitter.emit("data", chunk),
    end: () => emitter.emit("end"),
  };
}

describe("parseJsonBody", () => {
  it("returns the parsed body when it is within the limit", async () => {
    const { req, state, send, end } = fakeRequest();
    const parsed = parseJsonBody(req, 100);
    send(Buffer.from(JSON.stringify({ name: "cat" })));
    end();
    expect(await parsed).toEqual({ name: "cat" });
    expect(state.destroyed).toBe(false);
  });

  it("destroys the request as soon as the body is over the limit", async () => {
    const { req, state, send } = fakeRequest();
    const parsed = parseJsonBody(req, 100);
    send(Buffer.alloc(101));
    await expect(parsed).rejects.toThrow("Request body too large");
    expect(state.destroyed).toBe(true);
  });

  it("with drainBytes, reads that much more before it destroys the request", async () => {
    const { req, state, send } = fakeRequest();
    const parsed = parseJsonBody(req, 100, 50);
    send(Buffer.alloc(101));
    await expect(parsed).rejects.toThrow("Request body too large");
    expect(state.destroyed).toBe(false);
    send(Buffer.alloc(49));
    expect(state.destroyed).toBe(false);
    send(Buffer.alloc(1));
    expect(state.destroyed).toBe(true);
  });
});
