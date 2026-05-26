import { ThreadStore } from "./threadStore.js";

/**
 * A sentinel `ThreadStore` placed on the `agencyStore` ALS frame for code
 * that runs **outside** any agent node body — specifically:
 *
 *  - module-level global-init (`__initializeGlobals`)
 *  - top-level callback registration (`__registerTopLevelCallbacks`)
 *  - the resume / rewind bootstrap loops before `setupNode` reconstitutes
 *    the per-node ThreadStore from `stack.threads` JSON
 *
 * After the ALS migration these scopes still need *some* `ThreadStore` on
 * the ALS frame so `getRuntimeContext()` returns a valid object. Pre-fix,
 * we put a plain `ThreadStore.withDefaultActive(...)` there — but any
 * accidental write from those scopes (e.g. someone calling
 * `systemMessage("…")` at module top-level) would silently disappear when
 * the bootstrap frame unwound, because that ThreadStore was discarded.
 *
 * BootstrapThreadStore replaces the silent-loss failure mode with a loud
 * one: every user-facing method throws with an actionable message.
 *
 * It deliberately does NOT override:
 *  - `setStatelogClient` — purely additive metadata; harmless to set
 *  - `toJSON` / `fromJSON` — never reached from bootstrap scope, but if
 *    something does serialize an empty store, the empty result is correct
 */
export class BootstrapThreadStore extends ThreadStore {
  private throwBootstrap(method: string): never {
    throw new Error(
      `Message threads are not available in this scope.\n` +
        `\n` +
        `  Called: ThreadStore.${method}()\n` +
        `\n` +
        `This usually means agency code at module top-level (a global ` +
        `\`const x = ...\`), inside a \`callback(...)\` registration, or in ` +
        `an \`onAgent*\` lifecycle hook tried to use a thread/message ` +
        `builtin. Those scopes run before any agent node has started, so ` +
        `there is no message thread to read from or write to.\n` +
        `\n` +
        `Fix: move the code inside a \`node\` or \`def\` body.\n` +
        `\n` +
        `See docs/dev/async-context.md ("Frame kinds") for details.`,
    );
  }

  override create(): never {
    return this.throwBootstrap("create");
  }
  override createAndReturnThread(): never {
    return this.throwBootstrap("createAndReturnThread");
  }
  override createSubthread(): never {
    return this.throwBootstrap("createSubthread");
  }
  override createAndReturnSubthread(): never {
    return this.throwBootstrap("createAndReturnSubthread");
  }
  override get(_id: string): never {
    return this.throwBootstrap("get");
  }
  override pushActive(_id: string): never {
    return this.throwBootstrap("pushActive");
  }
  override popActive(): never {
    return this.throwBootstrap("popActive");
  }
  override activeId(): never {
    return this.throwBootstrap("activeId");
  }
  override active(): never {
    return this.throwBootstrap("active");
  }
  override getOrCreateActive(): never {
    return this.throwBootstrap("getOrCreateActive");
  }
}
