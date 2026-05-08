export type KeyEvent = {
  key: string;
  shift?: boolean;
  ctrl?: boolean;
};

export type InputSource = {
  nextKey(): Promise<KeyEvent>;
  nextLine(prompt: string): Promise<string>;
  destroy(): void;
};
