import { rpcClient } from "@/core/client";
import { colorHex, colorNumber } from "@/core/color";
import { config } from "@/core/config";
import { logger as mainLogger } from "@/core/logger";
import { ProtocolABI, Slasher, TerminationError } from "@forest-protocols/sdk";
import { parseEventLogs } from "viem";
import { startValidation } from "./threads";
import { ensureError } from "@/utils/ensure-error";
import { abortController, isTermination } from "./signal";
import { sleep } from "@/utils/sleep";

const logger = mainLogger.child({ context: "Blockchain" });

async function getBlock(num: bigint) {
  try {
    return await rpcClient.getBlock({
      blockNumber: num,
      includeTransactions: true,
    });
  } catch {
    // logger.debug(err.stack);
  }
}

function logInfo(message: string, options?: any) {
  if (config.LISTEN_BLOCKCHAIN) {
    logger.info(message, options);
  }
}

function logDebug(message: string, options?: any) {
  if (config.LISTEN_BLOCKCHAIN) {
    logger.debug(message, options);
  }
}

async function waitBlock(num: bigint) {
  logDebug(`Waiting for block ${colorNumber(num)}`);
  while (!abortController.signal.aborted) {
    const block = await getBlock(num);

    if (block) return block;
    await sleep(2000);
  }
  throw new TerminationError();
}

export async function listenToBlockchain() {
  const slasher = new Slasher({
    client: rpcClient,
    address: config.SLASHER_ADDRESS,
    registryContractAddress: config.REGISTRY_ADDRESS,
  });

  try {
    let currentBlock = await rpcClient.getBlockNumber();
    let isRevealWindowNotified = false;

    while (!abortController.signal.aborted) {
      // Get block or wait until it is available
      const block =
        (await getBlock(currentBlock)) || (await waitBlock(currentBlock));

      // If the listening enabled, then process the TXs
      if (config.LISTEN_BLOCKCHAIN) {
        // Check if block has TXs inside
        if (block.transactions.length == 0) {
          logDebug(
            `No transactions found in block ${colorNumber(
              currentBlock
            )}, skipping...`
          );

          currentBlock++;
          continue;
        }

        // Check TXs
        logDebug(`Processing block ${colorNumber(block.number)}`);
        for (const tx of block.transactions) {
          // If this TX is not belong to the Protocol that we are looking for, skip it.
          if (
            !tx.to ||
            tx.to.toLowerCase() != config.PROTOCOL_ADDRESS.toLowerCase()
          ) {
            continue;
          }

          const receipt = await rpcClient.getTransactionReceipt({
            hash: tx.hash,
          });

          if (receipt.status == "reverted") {
            logDebug(`TX (${colorHex(tx.hash)}) was reverted, skipping...`);
            continue;
          }

          const events = parseEventLogs({
            abi: ProtocolABI,
            logs: receipt.logs,
          });

          for (const event of events) {
            if (event.eventName == "OfferRegistered") {
              logInfo(
                `New Offer registered in the Protocol, ID ${colorNumber(
                  event.args.id
                )}`
              );
              // Start validation process for each of the configured Validators
              for (const [, validator] of Object.entries(config.validators)) {
                startValidation(validator, event.args.id);
              }
            }
          }
        }
      }

      const currentEpochEndBlock = await slasher.getCurrentEpochEndBlock();
      const revealWindowEnd =
        currentEpochEndBlock + (await slasher.getRevealWindow());

      // When current Epoch is over
      if (currentBlock > revealWindowEnd && config.CLOSE_EPOCH) {
        let epochClosed = false;

        // TODO: Which Validator should have this responsibility?

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
            `Epoch is closed by Validator "${validator.tag}" (${colorHex(
              validator.actorInfo.ownerAddr
            )})`
          );
          epochClosed = true;
        } catch (err: unknown) {
          const error = ensureError(err);
          logger.warning(
            `Error while trying to close Epoch (${colorNumber(
              currentEpochEndBlock
            )}): ${error.stack}`
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
              `Error while trying to emit rewards for Epoch (${colorNumber(
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

      currentBlock++;
    }
  } catch (err: unknown) {
    const error = ensureError(err);
    if (!isTermination(error)) {
      logger.error(`Error: ${error.stack}`);
    }
  }

  logger.info("Blockchain listener has stopped");
}
