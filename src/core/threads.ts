import { colorNumber } from "@/core/color";
import { config } from "@/core/config";
import { logger as mainLogger } from "@/core/logger";
import { ensureError } from "@/utils/ensure-error";
import { Validator } from "@/core/validator";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { Worker } from "worker_threads";
import { customAlphabet } from "nanoid";
import { ThreadMessageType, ValidationResult } from "@/core/types";
import { DB } from "@/database/client";
import { Mutex } from "async-mutex";
import { abortController, isTermination } from "@/core/signal";
import { ResourceIsNotOnlineError } from "@/errors/ResourceIsNotOnlineError";
import { TerminationError } from "@forest-protocols/sdk";
import { randomInteger } from "@/utils/random-integer";
import { sleep } from "@/utils/sleep";

let validationThreadCount = 0;
const validationThreadCountMutex = new Mutex();
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const nanoid = customAlphabet("0123456789abcdefghijklmnoprstuvyz", 15);

export let validationSessionsCount = 0;

async function waitForFreeThreadSlot() {
  while (!abortController.signal.aborted) {
    const release = await validationThreadCountMutex.acquire();
    if (validationThreadCount < config.MAX_CONCURRENT_VALIDATION) {
      validationThreadCount++;
      release();
      return;
    }
    release();

    await sleep(randomInteger(500, 1000)); // 0.5-1 second
  }
  throw new TerminationError();
}

export async function startValidation(validator: Validator, offerId: number) {
  const startedAt = new Date();

  // Generate an ID for this session
  const sessionId = nanoid();
  const logger = mainLogger.child({
    context: `Validator(${validator.tag}/${sessionId})`,
  });
  logger.debug(`Active validation session count: ${++validationSessionsCount}`);
  logger.info(
    `Starting a new validation (${sessionId}) for Offer ${colorNumber(
      offerId
    )} ->`
  );

  let agreementId: number | undefined = undefined;

  try {
    // Enter a new Agreement
    const enterAgreementResult = await validator.enterAgreement(
      offerId,
      sessionId
    );
    const operatorAddress = enterAgreementResult.operatorAddress;
    agreementId = enterAgreementResult.agreementId;

    // Give some time to the Provider
    await sleep(5000);

    const resource = await validator.waitResourceToBeOnline(
      agreementId,
      operatorAddress,
      sessionId
    );

    // Wait until there is an empty slot for this thread
    await waitForFreeThreadSlot();

    // Start a new thread for the actual execution of the Tests
    const worker = new Worker(
      join(__dirname, "..", "threads", "validation.js"),
      {
        workerData: {
          validatorTag: validator.tag,
          resource,
          agreementId: resource?.id,
          sessionId,
        },
      }
    );

    // Setup abort handler for worker thread
    const abortHandler = () => worker.terminate();
    abortController.signal.addEventListener("abort", abortHandler);

    // Because of the Promise, the function will wait this line
    // until the worker thread finishes its job
    await new Promise<void>((res, rej) => {
      worker.on("exit", async () => {
        abortController.signal.removeEventListener("abort", abortHandler);
        await validationThreadCountMutex.runExclusive(
          () => validationThreadCount--
        );
        res();
      });

      worker.on("error", (err) => rej(err));

      worker.on(
        "message",
        async (message: { type: ThreadMessageType; data: any }) => {
          if (message.type == ThreadMessageType.ValidationCompleted) {
            const result: ValidationResult = message.data;

            // Only save them if there is any results
            if (result.testResults.length > 0) {
              await DB.saveValidation(
                {
                  agreementId: agreementId!, // At this point Agreement is already created
                  offerId,
                  sessionId,
                  startedAt,
                  score: message.data.score,
                  providerId: resource.providerId,
                  validatorId: validator.actorInfo.id,
                },
                message.data.testResults
              );
            }

            // Check validations to be committed, asynchronously
            validator.commitValidations();
          }
        }
      );
    });
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
    // If the Agreement is already there, close it.
    if (agreementId !== undefined) {
      await validator.closeAgreement(agreementId, sessionId);
    }

    logger.debug(
      `Active validation session count: ${--validationSessionsCount}`
    );
    logger.info(
      `<- Validation (${sessionId}) for Offer ${colorNumber(offerId)} is over`
    );

    // If abort signal has been received and this is the last validation session then exit
    if (abortController.signal.aborted && validationSessionsCount == 0) {
      mainLogger.warning("Exit...");
      process.exit();
    }
  }
}
