import { BaseValidationExecutor } from "@/base/BaseValidationExecutor";
import { config } from "@/core/config";
import { logError } from "@/core/logger";
import { randomInteger } from "@/utils/random-integer";
import { readableTime } from "@/utils/readable-time";
import { sleep } from "@/utils/sleep";
import { Offer } from "@forest-protocols/sdk";

/**
 * Executes Validation sessions in a pre-defined interval and in an async manner.
 */
export class IntervalValidationExecutor extends BaseValidationExecutor {
  activeSessions = 0;

  async exec() {
    if (!config.VALIDATE_INTERVAL) {
      throw new Error(`VALIDATE_INTERVAL environment variable is not defined`);
    }

    // Keep track of all of the calls so we can wait them in the end of the function
    const startSessionCalls: Promise<any>[] = [];

    while (this.isAlive) {
      try {
        const [offer] = await this.getOffersToBeTested();

        if (offer === undefined) {
          // No Offer is found, wait a little bit
          await sleep(10_000);
          continue;
        }

        // How many sessions will be started
        const nextSessionCount = 1 * Object.keys(config.validators).length;

        if (this.activeSessions >= config.MAX_CONCURRENT_VALIDATION) {
          // There is no space to start a new Validation session
          continue;
        }

        // Increase active session count so we can respect the limit
        this.activeSessions += nextSessionCount;

        // Start Validation sessions for the chosen Offer
        startSessionCalls.push(
          this.startSessions([offer])
            .then(async (sessions) => {
              // Save results to the database
              for (const session of sessions) {
                await this.saveValidationSession(session);
              }

              // Notify Validators so they can commit those Validation results to the blockchain
              await this.commitResultsToBlockchain();
            })
            .finally(() => (this.activeSessions -= nextSessionCount))
        );
        const interval = this.getInterval();

        this.logger.info(
          `Next validation will start in ${readableTime(interval)}`
        );

        this.logger.debug(`Active Validation sessions ${this.activeSessions}`);

        // Wait until the next iteration start
        await sleep(interval);
      } catch (err) {
        logError({
          err,
          logger: this.logger,
          prefix: `Error while choosing an Offer:`,
        });
      }
    }

    // Daemon is not alive anymore (aka termination signal is received)
    // wait until all of the sessions done with their job
    if (config.GRACEFUL_SHUTDOWN) {
      await Promise.all(startSessionCalls);
    }
  }

  protected async selectOffers(allOffers: Offer[]): Promise<Offer[]> {
    const randomOffer = allOffers[randomInteger(0, allOffers.length - 1)];

    return [randomOffer];
  }

  /**
   * Calculates the next interval.
   */
  getInterval() {
    if (typeof config.VALIDATE_INTERVAL === "object") {
      return randomInteger(
        config.VALIDATE_INTERVAL.start,
        config.VALIDATE_INTERVAL.end
      );
    }

    return config.VALIDATE_INTERVAL!;
  }
}
