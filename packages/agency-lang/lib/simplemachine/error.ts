export class SimpleMachineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SimpleMachineError";
  }
}
