// Types for waiter.js, the helper behind awaits-helper.agency.
export function waitForTest(): Promise<void>;
export function untilWaiting(): Promise<void>;
export function releaseWaiter(): void;
export function setInnerModule(mod: unknown): void;
export function runInner(): Promise<unknown>;
export function noteAgentEnd(who: string): void;
export function agentEndNotes(): string[];
export function clearAgentEndNotes(): void;
