export type KeyEvent = {
  key: string;
  shift?: boolean;
  ctrl?: boolean;
  /** Alt (Option on a Mac): the terminal sent ESC and then the key. */
  alt?: boolean;
  /**
   * For `key: "paste"` events emitted when the terminal is in
   * bracketed-paste mode, the full pasted text. Undefined for normal
   * keypresses.
   */
  text?: string;
};

export type InputSource = {
  nextKey(): Promise<KeyEvent>;
  nextLine(prompt: string): Promise<string>;
  destroy(): void;
};
