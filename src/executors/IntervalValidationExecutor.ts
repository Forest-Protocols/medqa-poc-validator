import { BaseValidationExecutor } from "@/base/BaseValidationExecutor";
import { config } from "@/core/config";
import { logError } from "@/core/logger";
import { activeValidations } from "@/core/threads";
import { randomInteger } from "@/utils/random-integer";
import { readableTime } from "@/utils/readable-time";
import { sleep } from "@/utils/sleep";
import { Offer } from "@forest-protocols/sdk";

/**
 * Executes Validation sessions in a pre-defined interval and in an async manner.
 */
export class IntervalValidationExecutor extends BaseValidationExecutor {
  async exec() {
    if (!config.VALIDATE_INTERVAL) {
      throw new Error(`VALIDATE_INTERVAL environment variable is not defined`);
    }

    while (this.isAlive) {
      try {
        const [offer] = await this.getOffersToBeTested();

        if (offer === undefined) {
          // No Offer is found, wait a little bit
          await sleep(10_000);
          continue;
        }

        if (activeValidations >= config.MAX_CONCURRENT_VALIDATION) {
          // There is no space to start a new validation session
          continue;
        }

        // Start Validations for the chosen Offer
        this.startSession([offer]);
      } catch (err) {
        logError({
          err,
          logger: this.logger,
          prefix: `Error while choosing an Offer:`,
        });
      }
      const interval = this.getInterval();

      this.logger.info(
        `Next validation will start in ${readableTime(interval)}`
      );
      await sleep(interval);
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
