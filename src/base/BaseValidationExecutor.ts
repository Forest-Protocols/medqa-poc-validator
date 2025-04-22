import { Offer, Protocol, Status } from "@forest-protocols/sdk";
import { logError, logger as mainLogger } from "@/core/logger";
import { rpcClient } from "@/core/client";
import { config } from "@/core/config";
import { startValidation } from "@/core/threads";
import { abortController, isTermination } from "@/core/signal";
import { yellow } from "ansis";

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
   * Starts the executor
   */
  async start() {
    this.logger.info(
      `Executor ${yellow.bold(this.constructor.name)} is started`
    );
    try {
      await this.exec();
    } catch (err) {
      // No need to log termination error
      if (!isTermination(err)) {
        logError({ err, logger: this.logger });
      }
    } finally {
      this.logger.warning(
        `Executor ${yellow.bold(this.constructor.name)} is finished`
      );
    }
  }

  /**
   * Starts Validation sessions for each of the given Offers and Validators.
   * If Validators are not specified, uses all of them that defined in the environment.
   * Waits all of the Validation sessions are completed.
   * @param offers The Offers to be tested
   * @param validatorTags The validators that will test the Offers
   */
  async startSession(offers: Offer[], validatorTags?: string[]) {
    const validations: Promise<Awaited<ReturnType<typeof startValidation>>>[] =
      [];

    if (!validatorTags) {
      validatorTags = Object.keys(config.validators);
    }

    for (const offer of offers) {
      for (const validatorTag of validatorTags) {
        validations.push(
          startValidation(config.validators[validatorTag], offer.id)
        );
      }
    }

    // Wait until all of them are completed
    return await Promise.all(validations);
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

    return await this.selectOffers(allOffers);
  }

  /**
   * Is the daemon still alive?
   */
  get isAlive() {
    return !abortController.signal.aborted;
  }
}
