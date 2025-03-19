export class ResourceIsNotOnlineError extends Error {
  agreementId: number;

  constructor(agreementId: number) {
    super("Resource is not being online");
    this.agreementId = agreementId;
    this.name = "ResourceIsNotOnlineError";
  }
}
