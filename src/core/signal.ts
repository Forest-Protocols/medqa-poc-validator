import { red, yellow } from "ansis";
import { TerminationError } from "@forest-protocols/sdk";
import { config } from "./config";

export const abortController = new AbortController();

["SIGINT", "SIGTERM"].forEach((signal) =>
  process.on(signal, () => {
    if (!abortController.signal.aborted) {
      // Trigger abort handlers if the option is enabled
      if (config.GRACEFUL_SHUTDOWN) {
        console.error(
          yellow(
            "[WARNING] Termination signal received. Finalizing current work."
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
      // Force close on the second attempt
      process.exit(255);
    }
  })
);
