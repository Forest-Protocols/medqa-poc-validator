import { indexerClient } from "@/core/client";
import { colorHex, colorNumber } from "@/core/color";
import { config } from "@/core/config";
import { logError, logger as mainLogger } from "@/core/logger";
import { ensureError } from "@/utils/ensure-error";
import { abortController } from "./signal";
import { sleep } from "@/utils/sleep";

const logger = mainLogger.child({ context: "Blockchain" });

export async function listenToBlockchain() {
  let currentBlock: bigint | undefined;
  let isRevealWindowNotified = false;

  while (!abortController.signal.aborted) {
    try {
      const networkState = await indexerClient.getNetworkState();
      const currentEpochEndBlock = BigInt(
        networkState.current.epochEndBlock.value
      );
      const revealWindowEnd = BigInt(
        networkState.current.revealWindowEndBlock.value
      );
      currentBlock = BigInt(networkState.current.block);

      // When current Epoch is over
      if (currentBlock > revealWindowEnd && config.CLOSE_EPOCH) {
        let epochClosed = false;

        // TODO: Which Validator should have this responsibility? Closing epoch and emitting rewards?

        // Pick up first Validator to close the Epoch
        const validatorTags = Object.keys(config.validators);
        const validator = config.validators[validatorTags[0]];
        try {
          logger.info(
            `Reveal Window is over, closing the Epoch (${colorNumber(
              currentEpochEndBlock
            )})`
          );
          await validator.closeEpoch();

          logger.info(
            `The epoch ${colorNumber(
              currentEpochEndBlock
            )} is closed by Validator "${validator.tag}" (${colorHex(
              validator.actorInfo.ownerAddr
            )})`
          );
          epochClosed = true;
        } catch (err: unknown) {
          const error = ensureError(err);
          logger.warning(
            `Epoch (${colorNumber(currentEpochEndBlock)}) couldn't be closed: ${
              error.stack
            }`
          );
        }

        if (epochClosed && config.EMIT_REWARDS) {
          try {
            logger.info(
              `Emitting rewards for the closed Epoch (${colorNumber(
                currentEpochEndBlock
              )})`
            );
            await validator.emitRewards(currentEpochEndBlock);
            logger.info(
              `Rewards are emitted for the closed Epoch (${colorNumber(
                currentEpochEndBlock
              )})`
            );
          } catch (err) {
            const error = ensureError(err);
            logger.warning(
              `Rewards couldn't be emitted for Epoch (${colorNumber(
                currentEpochEndBlock
              )}): ${error.stack}`
            );
          }
        }

        // Now we are no longer in the old reveal window.
        isRevealWindowNotified = false;
        currentBlock++;
        continue;
      }

      // We are in a Reveal Window
      if (
        currentBlock > currentEpochEndBlock &&
        currentBlock <= revealWindowEnd
      ) {
        // Log once, but notify validators along the reveal window
        // (they may have faced with errors with the old notification)
        if (!isRevealWindowNotified) {
          isRevealWindowNotified = true;
          logger.debug(
            "Reveal window detected. Notifying validators to reveal their results"
          );
        }

        const promises: Promise<unknown>[] = [];

        // Reveal all of the committed results
        for (const [, validator] of Object.entries(config.validators)) {
          promises.push(validator.revealResults());
        }
        await Promise.all(promises);
      }

      // Wait a little bit between iterations
      await sleep(2000);
    } catch (err: unknown) {
      logError({ err, logger });
    }
  }

  logger.info("Blockchain listener has stopped");
}
