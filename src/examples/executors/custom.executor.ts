import { BaseValidationExecutor } from "@/base/BaseValidationExecutor";
import { logError } from "@/core/logger";
import { ValidationSessionInfo } from "@/core/types";
import { randomInteger } from "@/utils/random-integer";
import { sleep } from "@/utils/sleep";
import { Offer } from "@forest-protocols/sdk";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { join } from "path";

export class ProtocolValidationExecutor extends BaseValidationExecutor {
  async exec() {
    const resultsPath = join(process.cwd(), "data", "guesses");
    mkdirSync(resultsPath, { recursive: true });

    while (this.isAlive) {
      try {
        const [offer] = await this.getOffersToBeTested();
        const sessions = await this.startSessions([offer]);

        for (const session of sessions) {
          writeFileSync(
            join(resultsPath, `results-${Date.now()}.json`),
            JSON.stringify(session.info, null, 2),
            { encoding: "utf-8" }
          );
        }

        // Collect result files
        const resultFiles = readdirSync(resultsPath, {
          encoding: "utf-8",
        }).filter((file) => file.toString().endsWith(".json"));

        // If we have enough results, (this condition can be changed)
        if (resultFiles.length >= 3) {
          for (const resultFile of resultFiles) {
            // Load the results from the file and convert it to a usable object.
            const path = join(resultsPath, resultFile);
            const guesses: ValidationSessionInfo = JSON.parse(
              readFileSync(path).toString()
            );

            // Dates were stored as ISO string, so we need to convert it into a real Date object.
            guesses.startedAt = new Date(guesses.startedAt);

            if (guesses.finishedAt !== undefined) {
              guesses.finishedAt = new Date(guesses.finishedAt);
            }

            // Save them to the database so in the next step
            // they will be able to committed to the blockchain
            await this.saveTestResults(
              guesses,

              // This is the score calculation method.
              randomInteger(0, 100)
            );

            // Delete the saved result.
            rmSync(path, { force: true });
          }

          // Commit results to the blockchain
          await this.commitResultsToBlockchain();
        }

        await sleep(1000);
      } catch (err) {
        logError({ err, logger: this.logger, prefix: "Something went wrong:" });
      }
    }
  }

  protected async selectOffers(allOffers: Offer[]): Promise<Offer[]> {
    // Choice only one random Offer
    const randomOffer = allOffers[randomInteger(0, allOffers.length - 1)];

    return [randomOffer];
  }
}
