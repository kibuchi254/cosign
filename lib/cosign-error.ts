/** A refusal from the core or agent, with the message they gave (shown to the user as is). */
export class CosignError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'CosignError';
  }
}
