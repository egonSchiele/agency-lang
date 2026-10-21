import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { memoryChannelPair, type Channel } from "./channel.js";
import { lineChannel } from "./lineChannel.js";

function received(channel: Channel): Promise<unknown> {
  return new Promise((resolve) => {
    const stop = channel.onMessage((message) => {
      stop();
      resolve(message);
    });
  });
}

function closed(channel: Channel): Promise<void> {
  return new Promise((resolve) => channel.onClose(resolve));
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("the in-memory channel pair", () => {
  it("delivers in order, and closing one side closes both", async () => {
    const [left, right] = memoryChannelPair();
    const seen: unknown[] = [];
    right.onMessage((message) => seen.push(message));
    left.send({ n: 1 });
    left.send({ n: 2 });
    await nextTick();
    expect(seen).toEqual([{ n: 1 }, { n: 2 }]);

    const leftClosed = closed(left);
    const rightClosed = closed(right);
    right.close();
    await Promise.all([leftClosed, rightClosed]);
    left.send({ n: 3 });
    await nextTick();
    expect(seen).toHaveLength(2);
  });
});

type SocketPair = { server: Channel; client: Channel; stop: () => Promise<void> };

/** A server and a client on a socket in a temporary directory, each
 *  wrapped as a channel. `serverMaxBytes` caps only the server's side, so
 *  a test can send it a message its own cap would have refused. */
async function socketPair(serverMaxBytes?: number): Promise<SocketPair> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-line-channel-"));
  const sockPath = path.join(dir, "s.sock");
  let listener: net.Server | undefined;
  const accepted = new Promise<Channel>((resolve) => {
    listener = net.createServer((socket) => resolve(lineChannel(socket, serverMaxBytes)));
    listener.listen(sockPath);
  });
  const clientSocket = net.connect(sockPath);
  await new Promise<void>((resolve) => clientSocket.once("connect", resolve));
  const client = lineChannel(clientSocket);
  const server = await accepted;
  return {
    server,
    client,
    stop: () =>
      new Promise((resolve) => {
        client.close();
        server.close();
        listener!.close(() => {
          fs.rmSync(dir, { recursive: true, force: true });
          resolve();
        });
      }),
  };
}

describe("the line channel over a socket", () => {
  it("round-trips a message larger than 64 KiB", async () => {
    const pair = await socketPair();
    const big = { text: "x".repeat(100 * 1024) };
    const got = received(pair.server);
    pair.client.send(big);
    expect(await got).toEqual(big);
    await pair.stop();
  });

  it("the receiving side closes the connection on a message over its cap", async () => {
    const pair = await socketPair(1024);
    const serverClosed = closed(pair.server);
    const clientClosed = closed(pair.client);
    pair.client.send({ text: "y".repeat(2048) });
    await Promise.all([serverClosed, clientClosed]);
    await pair.stop();
  });

  it("two messages under the cap that arrive together both get through", async () => {
    const pair = await socketPair(1024);
    const seen: unknown[] = [];
    const both = new Promise<void>((resolve) => {
      pair.server.onMessage((message) => {
        seen.push(message);
        if (seen.length === 2) {
          resolve();
        }
      });
    });
    pair.client.send({ text: "a".repeat(600) });
    pair.client.send({ text: "b".repeat(600) });
    await both;
    expect(seen).toEqual([{ text: "a".repeat(600) }, { text: "b".repeat(600) }]);
    await pair.stop();
  });

  it("the last message sent before close still arrives", async () => {
    const pair = await socketPair();
    const got = received(pair.server);
    pair.client.send({ text: "z".repeat(1024 * 1024) });
    pair.client.close();
    expect(await got).toEqual({ text: "z".repeat(1024 * 1024) });
    await pair.stop();
  });

  it("tells the other side when a socket closes", async () => {
    const pair = await socketPair();
    const serverClosed = closed(pair.server);
    pair.client.close();
    await serverClosed;
    await pair.stop();
  });
});
