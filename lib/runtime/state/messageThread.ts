import * as smoltalk from "smoltalk";
import { nanoid } from "nanoid";

export type MessageThreadJSON = {
  messages: smoltalk.MessageJSON[];
};

export class MessageThread {
  messages: smoltalk.Message[] = [];
  id: string;

  constructor(messages: smoltalk.Message[] = []) {
    this.messages = messages;
    this.id = nanoid();
  }

  addMessage(message: smoltalk.Message): void {
    this.messages.push(message);
  }

  cloneMessages(): smoltalk.Message[] {
    return this.messages
      .map((m) => m.toJSON())
      .map((m) => smoltalk.messageFromJSON(m));
  }

  getMessages(): smoltalk.Message[] {
    return this.messages;
  }

  setMessages(messages: smoltalk.Message[]): void {
    this.messages = messages;
  }

  push(message: smoltalk.Message): void {
    this.messages.push(message);
  }

  newChild(): MessageThread {
    const child = new MessageThread();
    return child;
  }

  newSubthreadChild(): MessageThread {
    const child = new MessageThread(this.cloneMessages());
    return child;
  }

  toJSON(): MessageThreadJSON {
    return {
      messages: this.messages.map((m) => m.toJSON()),
    };
  }

  static fromJSON(
    json: MessageThreadJSON | MessageThread | smoltalk.MessageJSON[],
  ): MessageThread {
    if (json instanceof MessageThread) return json;
    const thread = new MessageThread();
    thread.messages = (Array.isArray(json) ? json : json.messages || []).map(
      (m: smoltalk.MessageJSON) => smoltalk.messageFromJSON(m),
    );
    return thread;
  }
}
