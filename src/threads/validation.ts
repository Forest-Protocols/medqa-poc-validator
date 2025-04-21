import { Validation } from "@/protocol/validation";
import { ThreadMessage } from "@/core/types";
import { parentPort, workerData } from "worker_threads";

const validatorTag = workerData.validatorTag;

async function main() {
  const validation = await Validation.create(
    validatorTag,
    workerData.resource,
    workerData.sessionId
  );
  const result = await validation.start();

  parentPort?.postMessage({
    type: ThreadMessage.ValidationCompleted,
    data: result,
  });

  await validation.close();
}

main();
