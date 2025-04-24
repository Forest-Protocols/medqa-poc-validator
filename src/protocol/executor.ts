import { BaseValidationExecutor } from "@/base/BaseValidationExecutor";
import { logError } from "@/core/logger";
import { randomInteger } from "@/utils/random-integer";
import { sleep } from "@/utils/sleep";
import { Offer } from "@forest-protocols/sdk";

/**
 * Custom Validation Executor implementation. If your Protocol has
 * a special case where the Validation sessions starts and finishes
 * depend on foreign conditions, you can implement your own way to
 * start them and collect their results.
 *
 * Check this example and if you need more,
 * check src/executors for more executor implementations.
 *
 * This class will be in use if `PROTOCOL_VALIDATION_EXECUTOR`
 * environment variable is given as `true`
 */
export class ProtocolValidationExecutor extends BaseValidationExecutor {
  async exec() {
    // Lifecycle of the executor starts right here ->

    /**
     * This `while` loop is necessary because you'll want to continuously
     * start Validation sessions as long as the daemon is alive.
     */
    while (this.isAlive) {
      try {
        const offers = await this.getOffersToBeTested();

        // TODO: Implement the logic how and when Validation sessions should start
        this.logger.warning(
          "Waiting for the implementation, check src/protocol/executor.ts"
        );

        /**
         * Example implementation ->
         */

        // Start Validation sessions for the chosen Offers
        const sessions = await this.startSessions(offers);

        // Save each of the session's result to the database
        for (const session of sessions) {
          await this.saveValidationSession(session);
        }

        // Commit all of the results that saved to the database to the blockchain.
        await this.commitResultsToBlockchain();

        /**
         * <- Example implementation
         */

        // Wait some time between each cycle
        await sleep(1000);
      } catch (err) {
        // Properly log error message
        logError({ err, logger: this.logger, prefix: "Something went wrong:" });
      }
    }

    // <- Lifecycle ends over here
  }

  /**
   * Implement how the Offers should selected among all of the
   * Offers that registered in the Protocol.
   *
   * This function returns array in case of you want to start multiple
   * Validation sessions at once from different Offers. If you don't,
   * simply you can return an array which contains only one item.
   * @param allOffers All the Offers registered in the Protocol
   * @returns The Offers that are going to be used in the Validation sessions
   */
  protected async selectOffers(allOffers: Offer[]): Promise<Offer[]> {
    // Choice only one random Offer
    const randomOffer = allOffers[randomInteger(0, allOffers.length - 1)];

    return [randomOffer];
  }
}
