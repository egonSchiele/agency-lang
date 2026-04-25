export interface BaseReviver<T> {
  nativeTypeName(): string;
  isInstance(value: unknown): value is T;
  serialize(value: T): Record<string, unknown>;
  validate(value: Record<string, unknown>): boolean;
  revive(value: Record<string, unknown>): T;
}
