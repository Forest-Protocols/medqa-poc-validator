import { join } from "path";
import { config } from "./core/config";
import { logError, logger } from "./core/logger";
import { readdirSync, readFileSync, rmSync, statSync } from "fs";
import { DB } from "./database/client";
import { Validator } from "./core/validator";
import { colorHex } from "./core/color";
import { IntervalValidationExecutor } from "./executors/IntervalValidationExecutor";
import { ProtocolValidationExecutor } from "./protocol/executor";
import { BaseValidationExecutor } from "./base/BaseValidationExecutor";
import { listenToBlockchain } from "./core/listener";
import { abortController } from "./core/signal";

const executors: BaseValidationExecutor[] = [];

if (config.VALIDATE_INTERVAL !== undefined) {
  executors.push(new IntervalValidationExecutor());
}

if (config.PROTOCOL_VALIDATION_EXECUTOR) {
  executors.push(new ProtocolValidationExecutor());
}

// Load detail files to the database
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

// Clear the human evaluation results
async function clearEvaluationsDirectory() {
  const path = join(process.cwd(), "data", "evaluations");

  if (statSync(path, { throwIfNoEntry: false })?.isDirectory()) {
    rmSync(path, { recursive: true, force: true });
    logger.debug(`Evaluations directory is cleared`);
  }
}

// Entry point of the daemon
async function main() {
  let failed = false;
  try {
    // Initialize
    await loadDetailFiles();
    await clearEvaluationsDirectory();
    await setupValidators();

    // Start blockchain listener to keep track of Reveal and Commit windows
    listenToBlockchain().catch((err) => logError({ err, logger }));
  } catch (err) {
    failed = true;
    logError({ err, logger });
  }

  if (!abortController.signal.aborted && !failed) {
    // Start all of the executors
    await Promise.all(executors.map((executor) => executor.start()));
  }

  // Clean all the Validators (aka gracefully destroy them)
  logger.info(`Cleaning Validators...`);
  for (const [, validator] of Object.entries(config.validators)) {
    await validator.clean();
  }

  // Disconnect from the database
  await DB.disconnect();

  logger.warning("See ya...");
  process.exit(process.exitCode || 0);
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
