export class InvalidValueError extends Error {
  value: unknown;

  constructor(value: unknown) {
    super("Invalid value");
    this.value = value;
    this.name = "InvalidValueError";
  }
}
