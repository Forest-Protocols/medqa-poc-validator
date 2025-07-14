import { indexerClient } from "@/core/client";
import { config } from "@/core/config";
import { logError, logger as mainLogger } from "@/core/logger";
import { abortController } from "./signal";
import { sleep } from "@/utils/sleep";
import { isAxiosError } from "axios";

const logger = mainLogger.child({ context: "Blockchain" });

export async function listenToBlockchain() {
  let currentBlock: bigint | undefined;
  let isRevealWindowNotified = false;
  let isIndexerHealthLogged = false;

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
      isIndexerHealthLogged = false;

      // When current Epoch is over
      if (currentBlock > revealWindowEnd && config.CLOSE_EPOCH) {
        let epochClosed = false;

        // TODO: Which Validator should have this responsibility? Closing epoch and emitting rewards?

        // Pick up first Validator to close the Epoch
        const validatorTags = Object.keys(config.validators);
        const validator = config.validators[validatorTags[0]];
        try {
          logger.info(`Reveal Window is over, closing the Epoch`, {
            epochEndBlock: currentEpochEndBlock,
            validatorTag: validator.tag,
            validatorOwnerAddress: validator.actorInfo.ownerAddr.toLowerCase(),
          });
          await validator.closeEpoch();

          logger.info(`The epoch is closed by Validator`, {
            epochEndBlock: currentEpochEndBlock,
            validatorTag: validator.tag,
            validatorOwnerAddress: validator.actorInfo.ownerAddr.toLowerCase(),
          });
          epochClosed = true;
        } catch (err: unknown) {
          logError({
            err,
            logger,
            prefix: `Epoch couldn't be closed`,
            meta: {
              epochEndBlock: currentEpochEndBlock,
              validatorTag: validator.tag,
              validatorOwnerAddress:
                validator.actorInfo.ownerAddr.toLowerCase(),
            },
          });
        }

        if (epochClosed && config.EMIT_REWARDS) {
          try {
            logger.info(`Emitting rewards for the closed Epoch`, {
              epochEndBlock: currentEpochEndBlock,
              validatorTag: validator.tag,
              validatorOwnerAddress:
                validator.actorInfo.ownerAddr.toLowerCase(),
            });
            await validator.emitRewards(currentEpochEndBlock);
            logger.info(`Rewards are emitted for the closed Epoch`, {
              epochEndBlock: currentEpochEndBlock,
              validatorTag: validator.tag,
              validatorOwnerAddress:
                validator.actorInfo.ownerAddr.toLowerCase(),
            });
          } catch (err) {
            logError({
              err,
              logger,
              prefix: `Rewards couldn't be emitted for Epoch`,
              meta: {
                epochEndBlock: currentEpochEndBlock,
                validatorTag: validator.tag,
                validatorOwnerAddress:
                  validator.actorInfo.ownerAddr.toLowerCase(),
              },
            });
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
          logger.info(`Reveal window detected. Notifying validators`, {
            epochEndBlock: currentEpochEndBlock,
          });
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
    } catch (err) {
      // If the error is an AxiosError, indexer might be down
      if (isAxiosError(err)) {
        const isHealthy = await indexerClient.isHealthy();

        // Log this error message only once
        if (!isHealthy && !isIndexerHealthLogged) {
          isIndexerHealthLogged = true;
          logger.error("Indexer is not healthy, cannot fetch data from it");
        }
      } else {
        logError({ err, logger });
      }
    }
  }

  logger.info("Blockchain listener has stopped");
}
