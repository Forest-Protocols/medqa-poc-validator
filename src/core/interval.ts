import { Protocol, TerminationError } from "@forest-protocols/sdk";
import { config } from "./config";
import { ensureError } from "@/utils/ensure-error";
import { rpcClient } from "@/core/client";
import { abortController, isTermination } from "./signal";
import { logger } from "@/core/logger";
import { startValidation, validationSessionsCount } from "./threads";
import { randomInteger } from "@/utils/random-integer";
import { sleep } from "@/utils/sleep";

function getInterval() {
  if (typeof config.VALIDATE_INTERVAL === "object") {
    return randomInteger(
      config.VALIDATE_INTERVAL.start,
      config.VALIDATE_INTERVAL.end
    );
  }

  return config.VALIDATE_INTERVAL!;
}

async function pickupRandomOffer(protocol: Protocol) {
  const offers = await protocol.getAllOffers(); /* [
        await protocol.getOffer(0),
      ]; */

  if (offers.length == 0) {
    logger.warning(`There are no registered Offer in this Protocol yet`);
    return;
  }

  return offers[randomInteger(0, offers.length - 1)];
}

export async function setupValidationInterval() {
  if (config.VALIDATE_INTERVAL === undefined) {
    return;
  }

  const protocol = new Protocol({
    client: rpcClient,
    address: config.PROTOCOL_ADDRESS,
    registryContractAddress: config.REGISTRY_ADDRESS,
  });

  while (!abortController.signal.aborted) {
    try {
      const offer = await pickupRandomOffer(protocol);

      if (offer === undefined) {
        continue;
      }

      if (validationSessionsCount >= config.MAX_CONCURRENT_VALIDATION) {
        // There is no space for the validation, just skip it
        continue;
      }

      // Start a validation for all of the configured Validators for the chosen Offer.
      for (const [, validator] of Object.entries(config.validators)) {
        startValidation(validator, offer.id);
      }
    } catch (err: unknown) {
      if (isTermination(err)) {
        break;
      }

      const error = ensureError(err);
      logger.error(`Error while choosing an Offer: ${error.stack}`);
    }
    await sleep(getInterval());
  }

  throw new TerminationError();
}
