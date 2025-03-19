import { TestResult } from "@/core/types";
import { AbstractTest } from "@/base/AbstractTest";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { sleep } from "@/utils/sleep";
import { readableTime } from "@/utils/readable-time";
import { BaseValidation } from "./BaseValidation";
import { config } from "@/core/config";

export type Output = Record<string, unknown>;
export type Evaluation<T extends Output> = {
  score: number;
  output: T;
};

/**
 * Abstract human evaluation class that can be used for
 * subjective tests where outputs are evaluated by real humans.
 */
export abstract class HumanEvaluationTest<
  T extends Output = {},
  K extends BaseValidation = BaseValidation
> extends AbstractTest<Evaluation<T>[], K> {
  /**
   * The amount of time before the evaluations are saved in milliseconds.
   */
  protected readonly waitEvaluationsFor = config.EVALUATION_WAIT_TIME;

  /**
   * Take the outputs from the resource and return as an array of object.
   * @param validation
   */
  abstract getOutputs(validation: K): Promise<T[]>;

  async execute(validation: K): Promise<TestResult<Evaluation<T>[]>> {
    let filePath: string | undefined;
    try {
      const outputs = await this.getOutputs(validation);
      const basePath = join(process.cwd(), "data", "evaluations");

      if (!statSync(basePath, { throwIfNoEntry: false })?.isDirectory()) {
        mkdirSync(basePath, {
          recursive: true,
          mode: 0o777,
        });
        this.logger.debug(`Evaluations directory is made`);
      }

      const timestamp = Date.now();
      const fileName = `eva-${this.constructor.name.toLowerCase()}-${timestamp}.json`;
      filePath = join(basePath, fileName);

      writeFileSync(
        filePath,
        JSON.stringify(
          outputs.map<Evaluation<T>>((output) => ({
            output,
            score: 0,
          }))
        ),
        {
          encoding: "utf-8",
          mode: 0o777,
        }
      );

      this.logger.info(
        `Place your evaluations to file "${fileName}" within ${readableTime(
          this.waitEvaluationsFor
        )}`
      );

      const startTime = Date.now();
      while (true) {
        await sleep(1000);
        const diff = Date.now() - startTime;

        if (diff > this.waitEvaluationsFor) {
          this.logger.info(`Time is up for ${fileName}. Loading results`);
          break;
        }
      }

      const content = readFileSync(filePath, { encoding: "utf-8" });
      const evaluations: Evaluation<T>[] = JSON.parse(content);
      // TODO: Use a zod schema to validate object (score and output)

      return {
        isSuccess: true,
        raw: `${evaluations.length} evaluations are done`,
        result: evaluations,
        testName: this.name,
      };
    } finally {
      // Cleaner logic for the evaluation file because it is no longer need.
      if (filePath && statSync(filePath, { throwIfNoEntry: false })?.isFile()) {
        rmSync(filePath, { force: true });
      }
    }
  }
}
