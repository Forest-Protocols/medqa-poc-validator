import { colorNumber } from "@/core/color";
import { config } from "@/core/config";
import { logger as mainLogger } from "@/core/logger";
import { ensureError } from "@/utils/ensure-error";
import { Validator } from "@/core/validator";
import { customAlphabet } from "nanoid";
import { Resource, ValidationResult } from "@/core/types";
import { DB } from "@/database/client";
import { abortController, isTermination } from "@/core/signal";
import { ResourceIsNotOnlineError } from "@/errors/ResourceIsNotOnlineError";
import { sleep } from "@/utils/sleep";
import { PromiseQueue } from "./queue";
import { Validation } from "@/protocol/validation";
import winston from "winston";

const validations = new PromiseQueue({
  concurrency: config.MAX_CONCURRENT_VALIDATION,
});
const nanoid = customAlphabet("0123456789abcdefghijklmnoprstuvyz", 15);

export let activeValidations = 0;

async function saveValidationResult(
  validationResult: ValidationResult,
  resource: Resource,
  sessionId: string,
  startedAt: Date,
  validator: Validator,
  logger: winston.Logger
) {
  // Only save them if there is any results
  if (validationResult.testResults.length > 0) {
    await DB.saveValidation(
      {
        agreementId: resource.id,
        offerId: resource.offerId,
        sessionId,
        startedAt,
        score: validationResult.score,
        providerId: resource.providerId,
        validatorId: validator.actorInfo.id,
      },
      validationResult.testResults
    );
  }

  // Check validations to be committed, asynchronously
  validator.commitValidations().catch((err) => {
    if (isTermination(err)) return;

    const error = ensureError(err);
    logger.error(
      `Error while committing results to the blockchain: ${error.stack}`
    );
  });
}

/**
 * Executes the validation process inside the main thread in async manner
 */
async function execValidation(
  startedAt: Date,
  sessionId: string,
  validator: Validator,
  resource: Resource,
  logger: winston.Logger
) {
  const validation = await Validation.create(
    validator.tag,
    resource,
    sessionId
  );
  const result = await validation.start();
  logger.info(`Score is ${result.score}`);

  await saveValidationResult(
    result,
    resource,
    sessionId,
    startedAt,
    validator,
    logger
  );
}

async function enterAgreement(
  sessionId: string,
  validator: Validator,
  offerId: number,
  onAgreementEntered: (agreementId: number) => void
) {
  // Enter a new Agreement
  const enterAgreementResult = await validator.enterAgreement(
    offerId,
    sessionId
  );
  const operatorAddress = enterAgreementResult.operatorAddress;
  const agreementId = enterAgreementResult.agreementId;
  onAgreementEntered(agreementId);

  // Give some time to the Provider
  await sleep(5000);

  // Wait until the Resource is being online
  return await validator.waitResourceToBeOnline(
    agreementId,
    operatorAddress,
    sessionId
  );
}

/**
 * Enters a new Agreement and executes the Validation on that Agreement.
 */
export async function startValidation(validator: Validator, offerId: number) {
  const startedAt = new Date();

  // Generate an ID for this session
  const sessionId = nanoid(); // TODO: rename to `validationId`
  const logger = mainLogger.child({
    context: `Validator(${validator.tag}/${sessionId})`,
  });
  logger.debug(`Active validations: ${++activeValidations}`);
  logger.info(
    `Starting a new validation (${sessionId}) for Offer ${colorNumber(
      offerId
    )} ->`
  );

  let agreementId: number | undefined = undefined;

  try {
    const resource = await enterAgreement(
      sessionId,
      validator,
      offerId,
      (id) => (agreementId = id)
    );

    await validations.queue(() =>
      execValidation(startedAt, sessionId, validator, resource, logger)
    );
  } catch (err: unknown) {
    const error = ensureError(err);

    if (error instanceof ResourceIsNotOnlineError) {
      logger.error(
        `Agreement ${colorNumber(error.agreementId)} is not being online.`
      );
    } else if (!isTermination(error)) {
      logger.error(`Error while validation: ${error.stack}`);
    }
  } finally {
    // If the Agreement was entered then close it.
    if (agreementId !== undefined) {
      await validator.closeAgreement(agreementId, sessionId).catch((err) => {
        const error = ensureError(err);
        logger.error(
          `Error while closing Agreement ${colorNumber(agreementId!)}: ${
            error.stack
          }`
        );
      });
    }

    logger.debug(`Active validations: ${--activeValidations}`);
    logger.info(
      `<- Validation (${sessionId}) for Offer ${colorNumber(offerId)} is over`
    );

    // If abort signal has been received and this is the last validation session then exit
    if (abortController.signal.aborted && activeValidations == 0) {
      mainLogger.warning("See ya...");
      process.exit();
    }
  }
}
