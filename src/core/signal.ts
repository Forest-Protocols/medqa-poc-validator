import { red, yellow } from "ansis";
import { TerminationError } from "@forest-protocols/sdk";
import { ensureError } from "@/utils/ensure-error";
import { config } from "./config";

export const abortController = new AbortController();

["SIGINT", "SIGTERM"].forEach((signal) =>
  process.on(signal, () => {
    if (!abortController.signal.aborted) {
      // Trigger abort handlers if the option is enabled
      if (config.GRACEFUL_SHUTDOWN) {
        console.error(
          yellow(
            "[WARNING] Termination signal received. Finalizing validations."
          )
        );
        process.exitCode = 1;
        abortController.abort(new TerminationError());
      } else {
        console.error(
          red(
            `[ERROR] Termination signal received. Graceful shutdown is disabled`
          )
        );
        // Otherwise just force exit
        process.exit(1);
      }
    } else {
      // Force close
      process.exit(255);
    }
  })
);

export function isTermination(err: Error | unknown) {
  const error = ensureError(err);
  let cause: Error | unknown | undefined = error;

  // Check all of the inner causes
  do {
    const causeError = ensureError(cause);
    cause = causeError.cause;

    if (causeError instanceof TerminationError) {
      return true;
    }
  } while (cause !== undefined);

  // If nothing found within inner causes, check the root error.
  return error instanceof TerminationError;
}
