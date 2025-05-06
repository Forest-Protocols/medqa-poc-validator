import { Offer, Protocol, Status } from "@forest-protocols/sdk";
import { logError, logger as mainLogger } from "@/core/logger";
import { rpcClient } from "@/core/client";
import { config } from "@/core/config";
import { abortController } from "@/core/signal";
import { yellow } from "ansis";
import { ValidationSession } from "@/core/session";
import { DB } from "@/database/client";
import { ValidationSessionInfo } from "@/core/types";
import { ensureError } from "@/utils/ensure-error";
import { isTermination } from "@/utils/is-termination";

/**
 * Base class for Validation executors.
 */
export abstract class BaseValidationExecutor {
  logger = mainLogger.child({ context: this.constructor.name });
  protocol: Protocol;

  constructor() {
    this.protocol = new Protocol({
      client: rpcClient,
      address: config.PROTOCOL_ADDRESS,
      registryContractAddress: config.REGISTRY_ADDRESS,
      signal: abortController.signal,
    });
  }

  /**
   * Implementation of how this executor work
   */
  protected abstract exec(): Promise<void>;

  /**
   * Pick ups the Offers that are going to be tested
   * @param allOffers All Offers from the Protocol
   */
  protected abstract selectOffers(allOffers: Offer[]): Promise<Offer[]>;

  /**
   * Saves the given Validation info alongside the score to the database.
   */
  async saveTestResults(info: ValidationSessionInfo, score: number) {
    if (info.testResults.length > 0) {
      try {
        await DB.saveValidation(
          {
            startedAt: info.startedAt,
            offerId: info.offerId,
            providerId: info.providerId,
            sessionId: info.sessionId,
            validatorId: info.validatorId,
            agreementId: info.agreementId,
            score: score,
          },
          info.testResults
        );
      } catch (err) {
        if (!isTermination(err)) {
          const error = ensureError(err);
          this.logger.warning(
            `Session ${info.sessionId} results couldn't save to the database: ${error.stack}`
          );
        }
      }
    }
  }

  /**
   * Calculates the score of the given Validation session and
   * saves the results to the database.
   */
  async saveValidationSession(session: ValidationSession) {
    // If the given session is executed and has some results
    if (session.testResults.length > 0 && session.validation) {
      try {
        const score = await session.validation.calculateScore(
          session.testResults
        );
        await this.saveTestResults(session.info, score);
      } catch (err) {
        if (!isTermination(err)) {
          const error = ensureError(err);
          this.logger.warning(
            `Session ${session.id} results couldn't save to the database: ${error.stack}`
          );
        }
      }
    }
  }

  /**
   * Notifies the given Validators to commit all of their
   * test results (that were saved to the database) to the blockchain.
   * If the blockchain is not in Commit Window state, simply the
   * call will be ignored.
   *
   * If Validators are not specified, it uses all of the configured ones.
   * @param validatorTags
   */
  commitResultsToBlockchain(validatorTags?: string[]) {
    if (!validatorTags) {
      validatorTags = Object.keys(config.validators);
    }

    for (const validatorTag of validatorTags) {
      config.validators[validatorTag].commitValidations().catch((err) =>
        logError({
          err,
          logger: this.logger,
          prefix: `Error while committing results by Validator ${validatorTag}:`,
        })
      );
    }
  }

  /**
   * Starts the executor
   */
  async start() {
    this.logger.info(
      `Executor ${yellow.bold(this.constructor.name)} is started`
    );
    try {
      await this.exec();
    } catch (err) {
      logError({ err, logger: this.logger });
    } finally {
      this.logger.warning(
        `Executor ${yellow.bold(this.constructor.name)} is finished`
      );
    }
  }

  /**
   * Starts Validation sessions for each of the given Offers and Validators.
   * If Validators are not specified, uses all of configured ones.
   * Waits all of the Validation sessions are completed.
   * @param offers The Offers to be tested
   * @param validatorTags The validators that will test the Offers
   * @returns Validation sessions
   */
  async startSessions(
    offers: Offer[],
    options?: {
      /**
       * Additional parameter that is going to be passed to the Validation
       */
      parameters?: Record<string, unknown>;

      /**
       * The Validators that are going to run the Validation process.
       */
      validatorTags?: string[];
    }
  ) {
    const validations: Promise<ValidationSession>[] = [];

    if (!options) {
      options = {};
    }

    if (!options?.validatorTags) {
      options.validatorTags = Object.keys(config.validators);
    }

    for (const offer of offers) {
      for (const validatorTag of options.validatorTags) {
        validations.push(
          new Promise((resolve, reject) => {
            const session = new ValidationSession({
              offer,
              validator: validatorTag,
            });
            session
              .start()
              .then(() => resolve(session))
              .catch(reject);
          })
        );
      }
    }

    // Wait until all of them are completed
    const sessions = await Promise.all(validations);
    return sessions;
  }

  /**
   * Gets the Offers that are going to be tested
   * among all the Offers that registered in the Protocol
   * based on `this.selectOffers` implementation.
   */
  async getOffersToBeTested(): Promise<Offer[]> {
    const allOffers = await this.protocol.getAllOffers();

    if (allOffers.length == 0) {
      this.logger.warning(`No Offers found`);
      return [];
    }

    // Filter active Offers
    const activeOffers = allOffers.filter((o) => o.status === Status.Active);

    // If we can't find even one active Offer,
    if (activeOffers.length === 0) {
      this.logger.warning(`No active Offers found`);
      return [];
    }

    return await this.selectOffers(activeOffers);
  }

  /**
   * Is the daemon still alive?
   */
  get isAlive() {
    return !abortController.signal.aborted;
  }
}
