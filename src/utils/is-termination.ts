import { TerminationError } from "@forest-protocols/sdk";
import { ensureError } from "./ensure-error";

/**
 * Recursively checks if the `err` or any of its causes
 * is a termination error.
 */
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
