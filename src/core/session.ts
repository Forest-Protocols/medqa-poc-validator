import { customAlphabet } from "nanoid";
import { Resource, TestResult, ValidationSessionInfo } from "./types";
import { Validator } from "./validator";
import { config } from "./config";
import winston from "winston";
import { logError, logger as mainLogger } from "./logger";
import { Validation } from "@/protocol/validation";
import { sleep } from "@/utils/sleep";
import { Offer, Provider, TerminationError } from "@forest-protocols/sdk";
import { abortController } from "./signal";

const nanoid = customAlphabet("0123456789abcdefghijklmnoprstuvyz", 15);

/**
 * Main class that handle the execution of Validation process.
 * Simply it enters a new Agreement, executes the Validation process and collects its results.
 */
export class ValidationSession {
  id = nanoid();
  startedAt = new Date();
  finishedAt: Date | undefined;
  validation: Validation | undefined;
  validator: Validator;
  provider: Provider;
  logger: winston.Logger;
  offer: Offer;
  resource: Resource | undefined;
  agreementId: number | undefined;
  testResults: TestResult[] = [];
  parameters?: Record<string, unknown>;

  /**
   * Instantiates a new Validation session for the given Offer and Validator
   */
  constructor(params: {
    /**
     * Validator tag or class itself
     */
    validator: Validator | string;

    /**
     * The Offer that is going to be tested
     */
    offer: Offer;

    /**
     * The Provider that is going to be used
     */
    provider: Provider;


    /**
     * The parameters that is going to be passed to the Validation
     */
    parameters?: Record<string, unknown>;
  }) {
    if (typeof params.validator === "string") {
      this.validator = config.validators[params.validator];
    } else {
      this.validator = params.validator;
    }

    this.parameters = params.parameters;
    this.offer = params.offer;
    this.provider = params.provider;
    this.logger = mainLogger.child({
      context: `Session`,
      id: this.id,
      offerId: this.offer.id,
      validatorTag: this.validator.tag,
      validatorOwnerAddress: this.validator.actorInfo.ownerAddr.toLowerCase(),
    });
  }

  /**
   * Starts the session and saves the test results into `testResults` array.
   */
  async start() {
    this.logger.info(`Starting a new Validation session`);

    try {
      await this.enterAgreement();

      // TODO: Maybe we can support execution of different "Validation" classes?
      this.validation = (await Validation.create(
        this.validator.tag,
        this.resource!,
        this.id,
        this.parameters
      )) as Validation;
      this.testResults = await this.validation.start();
    } catch (err) {
      logError({
        err,
        logger: this.logger,
        prefix: `Error in execution of the Validation process`,
        meta: {
          agreementId: this.agreementId,
        },
      });
    } finally {
      // If the Agreement is entered, close it
      if (this.agreementId !== undefined) {
        await this.validator
          .closeAgreement(this.agreementId, this.id)
          .catch((err) =>
            logError({
              err,
              logger: this.logger,
              prefix: `Error while closing Agreement`,
              meta: {
                agreementId: this.agreementId,
              },
            })
          );
      }

      this.finishedAt = new Date();
      this.logger.info(`Validation session is over`, {
        agreementId: this.agreementId,
      });
    }
  }

  /**
   * Information about the session as a plain object
   */
  get info(): ValidationSessionInfo {
    if (abortController.signal.aborted) {
      throw new TerminationError();
    }

    if (
      this.agreementId === undefined
    ) {
      throw new Error(`Validation session doesn't have required information`);
    }

    return {
      agreementId: this.agreementId,
      offerId: this.offer.id,
      providerId: this.provider.id,
      sessionId: this.id,
      startedAt: this.startedAt,
      validatorId: this.validator.actorInfo.id,
      testResults: this.testResults,
      finishedAt: this.finishedAt,
    };
  }

  /**
   * Returns whether the session is completed properly
   * e.g Agreement is entered, Validation is executed and finished.
   */
  get isCompleted() {
    try {
      // `this.info` throws an error if the session is not completed
      // and `finishedAt` indicates that the session is completed.
      return this.info.finishedAt !== undefined;
    } catch {
      return false;
    }
  }

  /**
   * Enters a new Agreement with the Offer
   */
  private async enterAgreement() {
    const enterAgreementResult = await this.validator.enterAgreement(
      this.offer.id,
      this.id
    );
    const operatorAddress = enterAgreementResult.operatorAddress;
    this.agreementId = enterAgreementResult.agreementId;
    this.provider = enterAgreementResult.provider;

    // Give some time to the Provider
    await sleep(5000);

    // Wait until the Resource is being online
    this.resource = await this.validator.waitResourceToBeOnline(
      this.agreementId,
      operatorAddress,
      this.id
    );
  }
}
