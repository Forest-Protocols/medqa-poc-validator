import { TestResult } from "@/core/types";
import { BaseValidation } from "@/base/BaseValidation";
import { ExampleTest } from "./tests/ExampleTest";
import { PipeMethod } from "@forest-protocols/sdk";
import { AbstractTestConstructor } from "@/base/AbstractTest";
import { ExampleHumanEvaluation } from "./tests/ExampleHumanEvaluation";

/**
 * Define the general necessary actions for your tests.
 *
 * NOTE: All of the validation related stuff will be executed in its own Thread.
 */
export class Validation extends BaseValidation {
  override readonly tests: AbstractTestConstructor[] = [
    /**
     * TODO: Place Test implementations
     */
    ExampleHumanEvaluation,
    ExampleTest,
  ];

  /**
   * Executed before starting to the validation.
   */
  override async onStart() {
    /**
     * TODO: Implement me, if needed
     */
  }

  /**
   * Executed after all of the Tests are run.
   */
  override async onFinish() {
    /**
     * TODO: Implement me, if needed
     */
  }

  /**
   * Calculates score of the Provider for this validation.
   */
  override async calculateScore(testResults: TestResult[]): Promise<number> {
    let score = 0;

    for (const testResult of testResults) {
      /**
       * TODO: Implement me
       *
       * An example implementation that gives 1 point
       * for each successfully completed `ExampleTest`.
       */
      if (testResult.isSuccess && testResult.testName == ExampleTest.name) {
        score += 1;
      }
    }

    return score;
  }

  /**
   * TODO: Add additional functions that needed by the tests
   *
   * An example one that calls Pipe endpoints:
   */
  async callEndpoint(path: `/${string}`, body: any) {
    return await this.pipe.send(this.resource.operatorAddress, {
      path,
      method: PipeMethod.GET,
      body,
    });
  }
}
