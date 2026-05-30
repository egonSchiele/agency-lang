import * as smoltalk from "smoltalk";
import { nanoid } from "nanoid";

export type MessageThreadJSON = {
  messages: smoltalk.MessageJSON[];
  parentId?: string | null;
  hidden?: boolean;
};

export class MessageThread {
  messages: smoltalk.Message[] = [];
  id: string;
  /** ID of the parent thread when this thread was created via
   *  `ThreadStore.createSubthread()`. `null` for top-level threads
   *  (the default `MessageThread` constructor leaves it null). Used by
   *  `agency.threads.list()` to surface the parent linkage in
   *  ThreadInfo, and by `ThreadStore.resumeExisting()` to reject
   *  resuming a subthread outside its parent's context. */
  parentId: string | null = null;
  /** When `true`, this thread is excluded from `agency.threads.list()`
   *  (and therefore the stdlib `listThreads()` user-facing surface).
   *  Set by `Runner.thread` at first-create time when the user opts
   *  in via `thread(hidden: true) { ... }`. Round-tripped through
   *  `toJSON`/`fromJSON` so the flag survives interrupt resume. */
  hidden: boolean = false;

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
      parentId: this.parentId,
      hidden: this.hidden,
    };
  }

  static fromJSON(
    json:
      | MessageThreadJSON
      | MessageThread
      | smoltalk.MessageJSON[]
      | smoltalk.Message[],
  ): MessageThread {
    if (json instanceof MessageThread) return json;
    const thread = new MessageThread();

    let _messages: any[] = [];
    let _parentId: string | null = null;
    let _hidden = false;
    if (Array.isArray(json)) {
      _messages = json;
    } else if ("messages" in json) {
      _messages = json.messages;
      if ("parentId" in json && json.parentId !== undefined) {
        _parentId = json.parentId;
      }
      if ("hidden" in json && json.hidden === true) {
        _hidden = true;
      }
    } else {
      throw new Error("Invalid input for MessageThread.fromJSON");
    }

    const messagesToJSON = _messages.map(
      (m: smoltalk.MessageJSON | smoltalk.Message) =>
        "toJSON" in m ? m.toJSON() : m,
    );

    const smoltalkMessages = messagesToJSON.map((m: smoltalk.MessageJSON) =>
      smoltalk.messageFromJSON(m),
    );

    thread.setMessages(smoltalkMessages);
    thread.parentId = _parentId;
    thread.hidden = _hidden;

    return thread;
  }
}
