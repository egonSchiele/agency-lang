import * as smoltalk from "smoltalk";
import { nanoid } from "nanoid";

export class MessageThread {
  messages: any[] = [];
  id: string;

  constructor(messages: any[] = []) {
    this.messages = messages;
    this.id = nanoid();
  }

  addMessage(message: any): void {
    this.messages.push(message);
  }

  cloneMessages(): any[] {
    return this.messages.map((m) => m.toJSON()).map((m) => smoltalk.messageFromJSON(m));
  }

  getMessages(): any[] {
    return this.messages;
  }

  setMessages(messages: any[]): void {
    this.messages = messages;
  }

  push(message: any): void {
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

  toJSON(): any {
    return {
      messages: this.messages.map((m) => m.toJSON()),
    };
  }

  static fromJSON(json: any): MessageThread {
    if (json instanceof MessageThread) return json;
    const thread = new MessageThread();
    thread.messages = (json.messages || []).map((m: any) => smoltalk.messageFromJSON(m));
    return thread;
  }
}
