export class NotEnoughUSDCError extends Error {
  constructor(
    balance: number | bigint | unknown,
    required: number | bigint | unknown,
    options?: ErrorOptions
  ) {
    super(
      `USDC balance (${balance}) is not enough. Required: ${required}`,
      options
    );
    this.name = "NotEnoughUSDCError";
  }
}
