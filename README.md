# Validator Template

This repository contains the template that should be customized by Protocol Owners according to their Protocol definitions. Protocols which have Validators get more emissions than the others.

Validators are daemon processes that are written for specific Protocol. Their purpose is executing some pre-defined tests on the services that are providing by Providers within that Protocol. Validators rank those Providers based on their service quality. Based on those ranks Providers get higher emissions.

Adding Validator support to your Protocol also increase your emissions. Because Validators increase the consistency and trustworthy of your Protocol.

# Quickstart

> This tutorial is for Protocol Owners

After you've done with [Provider Template](https://github.com/Forest-Protocols/provider-template) follow up the guide below to start to implement your Validator daemon

Index:

- [Fork and edit the repository](#fork-and-edit-the-repository),

## Fork and edit the repository

The working diagram of Validator daemon is shown below:
![diagram](docs/images/validator-diagram.png)

The daemon have only one validation definition and they can be running simultaneously. That one validation definition can have bunch of tests inside of it.

Since each Protocol has its own type of service, Validation process and Tests should be customized for each Protocol. First Fork this repository and clone it locally. Then open `src/protocol/validation.ts` file. You'll see a class called `Validation`. This class includes the general actions that are shared between "Tests". Each Test has its own logic in order to test something specific.

In this file the most important part is `calculateScore` method which calculates the total score of a single Validation session based on the Test results. Based on those scores, Providers will get higher emissions. So you need to implement this function wisely. The score should be a positive integer value. The range of score is depend on the implementation. Just be sure that good service will get high score and bad service get low.

As an example in this guide we will implement a Validation session and write speed test for a PostgreSQL Protocol (we assume that we already registered one). Take this example as a reference and implement your own logic according to your Protocol.

Check the code below;

```typescript
import { TestResult } from "@/core/types";
import { BaseValidation } from "@/base/BaseValidation";
import { AbstractTestConstructor } from "@/base/AbstractTest";
import pg from "pg";

// Import tests
import { WriteSpeedTest, WriteSpeedTestResult } from "./tests/WriteSpeedTest";

/**
 * This is the type of details that Validator will fetch from the Provider.
 * In our case we know that Providers will provide connection string for the
 * resources.
 */
export type ResourceDetails = {
  connectionString: string;
};

/**
 * Define the general necessary actions for your tests.
 *
 * NOTE: Each validation run in its own thread.
 */
export class Validation extends BaseValidation<ResourceDetails> {
  // We need to add all of Test implementations into this array.
  // These tests will be executed within the Validation session.
  override readonly tests: AbstractTestConstructor[] = [WriteSpeedTest];

  // Tests will need to connect to the database. Since this is
  // a shared action, we define it in Validation level so all
  // Test implementations will have access to it.
  // For this example we are going to use `pg` package to connect PostgreSQL
  // databases. More info: https://www.npmjs.com/package/pg
  connection!: pg.Client;

  /**
   * Executed before starting to the validation.
   */
  override async onStart() {
    // Initialize the connection
    this.connection = new pg.Client({
      // Validation class has a `resource` field which points to the purchased Resource
      // You can get various information about the resource by that field.
      connectionString: this.resource.details.connectionString,
    });

    // Connect to the database before executing Tests
    await this.connection.connect();
    this.logger.info("Connected to the database");
  }

  /**
   * Executed after all of the Tests are run.
   */
  override async onFinish() {
    // Disconnect from the database.
    await this.connection.end();
    this.logger.info("Disconnected from the database");
  }

  /**
   * Calculates score of the Provider for this validation.
   */
  override async calculateScore(testResults: TestResult[]): Promise<number> {
    let score = 0;

    for (const testResult of testResults) {
      // If the result belongs to WriteSpeedTest
      if (testResult.testName === WriteSpeedTest.name) {
        const result: WriteSpeedTestResult =
          testResult.result as WriteSpeedTestResult;

        // Lower elapsed time will have higher score.
        score += Math.floor(100 / result.elapsedTimeMs);
      }
    }

    return score;
  }
}
```

Then create another file called `src/protocol/tests/WriteSpeedTest.ts`. This will include our actual test class implementation:

```typescript
import { TestResult } from "@/core/types";
import { AbstractTest } from "@/base/AbstractTest";
import { Validation } from "../validation";

/**
 * This is the type that will be returned by this Test as a structured output.
 * Each Test has a raw output and a structured output.
 *
 * Raw output is a simple string and most of the time it is not machine readable.
 * On the other hand structured output can be used in score calculation phase.
 *
 * This type represents the structured output type of this Test.
 */
export type WriteSpeedTestResult = {
  elapsedTimeMs: number;
};

/**
 * A Test implementation. Each Test must inherit from `AbstractTest`. Unless
 * it is not a human evaluation test. First generic parameter of
 * AbstractTest points to the structured result type of this test
 * and second one points to the Validation class which you don't need to change.
 */
export class WriteSpeedTest extends AbstractTest<
  WriteSpeedTestResult, // Test result type
  Validation // Validation type
> {
  /**
   * Actual logic that performs test.
   * @param validation Validation session
   * @returns Results of the test
   */
  async execute(
    validation: Validation
  ): Promise<TestResult<WriteSpeedTestResult>> {
    try {
      // Create a table
      await validation.connection.query(`
        CREATE TABLE test_data (
          id INT AUTO_INCREMENT PRIMARY KEY,
          data TEXT
          );`);

      // Insert some data and measure elapsed time
      const startTime = Date.now();
      await validation.connection.query(`
          INSERT INTO test_data (data)
          VALUES ('Test data row 1 askdjanskdjnaskdnaksdjnaskjdn1231c23c123c1c31c31c31c31i321ci3n1ic2n31i2n31io23n1i23n1i23n1in31i23n1in31i3n1ic3');
        `);

      // Return the test results
      return {
        isSuccess: true,
        raw: (startTime - Date.now()).toString(),
        result: {
          elapsedTimeMs: startTime - Date.now(),
        },
        testName: this.name,
      };
    } finally {
      // Delete the test table after the test is complete or in case of error
      await validation.connection.query(`DROP TABLE test_data;`);
    }
  }
}
```

`WriteSpeedTest` is a "Automated Performance Test". That means the code itself can do the test. But if your Protocol service cannot be tested with that approach, in case the outputs/results must be evaluated by real humans (e.g image generation, translation, video generation), you can use `HumanEvaluationTest` instead of `AbstractTest`.

In human evaluation test, once the test is started, it fetches the outputs from the service and save those outputs under `data/evaluations` directory as JSON files. Human evaluators need to submit their scores for the generated outputs within those files before the defined time runs out.

A human evaluation test for a translation service would look like this:

```typescript
import { randomInteger } from "@/utils/random-integer";
import { Validation } from "../validation";
import { HumanEvaluationTest } from "@/base/HumanEvaluationTest";
import { sleep } from "@/utils/sleep";
import { parseTime } from "@/utils/parse-time";

/**
 * Generated output by the service. Human evaluators will
 * see this structure within the evaluation JSON files.
 */
export type ExampleHumanEvaluationOutput = {
  sourceLanguage: string;
  targetLanguage: string;
  sourceText: string;
  translatedText: string;
};

/**
 * Test implementation which uses human evaluation approach.
 */
export class ExampleHumanEvaluation extends HumanEvaluationTest<
  ExampleHumanEvaluationOutput,
  Validation
> {
  /**
   * Wait evaluation scores before load them from the output files.
   * In this case it is 1 minute (m = minute, h = hour, s = second)
   */
  protected override readonly waitEvaluationsFor = parseTime("1m");

  /**
   * Fetch the outputs from the service for a specific prompt.
   */
  async getOutputs(
    validation: Validation
  ): Promise<ExampleHumanEvaluationOutput[]> {
    /**
     * Implement the actual logic that retrieves
     * the outputs from the resource for specific prompts.
     *
     * Example dummy logic for translation evaluation:
     */

    const sourceEN = [
      "We live in a big house.",
      "He is my friend.",
      "I have a cat.",
    ];
    const targetSP = [
      "Tengo un gato.",
      "Ella es mi amiga",
      "We live in a big house.",
    ];

    // Simulate a process that take some time (like generating output)
    await sleep(3000);

    /**
     * Return the array of outputs so human
     * evaluators will be able to evaluate those results.
     */
    return Array<ExampleHumanEvaluationOutput>(5).fill({
      sourceLanguage: "english",
      targetLanguage: "spanish",
      sourceText: sourceEN[randomInteger(0, sourceEN.length)],
      translatedText: targetSP[randomInteger(0, targetSP.length)],
    });
  }
}
```

Once you are done with your implementation of test(s), you are good to go! You can commit your changes, push and publish it so people can download it and participate your Protocol as a Validator.

Also you can replace this README file with `docs/become-a-validator.md` so people will see that file when they visit your Validator Daemon's GitHub repository.
