export class ReviewEndedError extends Error {
  constructor(
    message: string,
    public readonly title = 'Request ended'
  ) {
    super(message);
  }
}
