import { logger as mainLogger } from "@/core/logger";
import { Validation } from "@/protocol/validation";
import { ThreadMessageType } from "@/core/types";
import { parentPort, workerData } from "worker_threads";

const validatorTag = workerData.validatorTag;
const logger = mainLogger.child({
  context: `Validator(${workerData.validatorTag}/${workerData.sessionId})`,
});

async function main() {
  const validation = await Validation.create(
    validatorTag,
    workerData.resource,
    workerData.sessionId
  );
  const result = await validation.start();
  logger.info(`Score is ${result.score}`);

  parentPort?.postMessage({
    type: ThreadMessageType.ValidationCompleted,
    data: result,
  });
}

main();
