import { join } from "path";
import { config } from "./core/config";
import { logger } from "./core/logger";
import { readdirSync, readFileSync, rmSync, statSync } from "fs";
import { DB } from "./database/client";
import { Validator } from "./core/validator";
import { listenToBlockchain } from "./core/listener";
import { ensureError } from "./utils/ensure-error";
import { colorHex } from "./core/color";
import { setupValidationInterval } from "./core/interval";
import { validationSessionsCount } from "./core/threads";
import { abortController, isTermination } from "./core/signal";

async function loadDetailFiles() {
  logger.info("Detail files are loading to the database");
  const basePath = join(process.cwd(), "data", "details");
  const files = readdirSync(basePath, { recursive: true }).filter((file) =>
    // Exclude sub-directories
    statSync(join(basePath, file.toString()), {
      throwIfNoEntry: false,
    })?.isFile()
  );
  const contents = files.map((file) =>
    readFileSync(join(basePath, file.toString())).toString("utf-8")
  );

  await DB.saveDetailFiles(contents);
}

// Initializes Validators based on the configurations
async function setupValidators() {
  for (const [tag, valConfig] of Object.entries(
    config.validatorConfigurations
  )) {
    logger.info(`Initializing validator "${tag}"`);
    config.validators[tag] = await Validator.create(tag, valConfig);
    logger.info(
      `Validator "${tag}" (${colorHex(
        config.validators[tag].actorInfo.ownerAddr
      )}) initialized`
    );
  }
}

async function clearEvaluationsDirectory() {
  const path = join(process.cwd(), "data", "evaluations");

  if (statSync(path, { throwIfNoEntry: false })?.isDirectory()) {
    rmSync(path, { recursive: true, force: true });
    logger.debug(`Evaluations directory cleared`);
  }
}

function errorHandler(err: unknown) {
  const error = ensureError(err);

  if (!isTermination(error)) {
    logger.error(`Error: ${error.stack}`);
  }
}

// Entry point of the daemon
async function main() {
  try {
    await loadDetailFiles();
    await clearEvaluationsDirectory();
    await setupValidators();

    await Promise.all([
      listenToBlockchain().catch(errorHandler),
      setupValidationInterval().catch(errorHandler),
    ]);
  } catch (err: unknown) {
    errorHandler(err);
  }

  logger.debug("Main function is over");
  if (validationSessionsCount == 0 && abortController.signal.aborted) {
    logger.warning("Exit...");
    process.exit();
  }
}

// To make BigInt values visible within JSON.stringify output.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
interface BigInt {
  /** Convert to BigInt to string form in JSON.stringify */
  toJSON: () => string;
}
(BigInt.prototype as any).toJSON = function () {
  return `BigInt(${this})`;
};

main();
