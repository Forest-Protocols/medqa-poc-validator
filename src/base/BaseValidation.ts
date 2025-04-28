import { Logger } from "winston";
import { AbstractTestConstructor } from "./AbstractTest";
import { Resource, TestResult } from "@/core/types";
import { colorKeyword } from "@/core/color";
import { ensureError } from "@/utils/ensure-error";
import { logger as mainLogger } from "@/core/logger";
import { config } from "@/core/config";
import { AbstractPipe } from "@forest-protocols/sdk";
import { isTermination } from "@/utils/is-termination";

export class BaseValidation<
  T extends Record<string, unknown> = {},
  K extends Record<string, unknown> = {}
> {
  protected logger!: Logger;
  protected sessionId!: string;
  protected validatorTag!: string;
  protected pipe!: AbstractPipe;
  protected readonly tests: AbstractTestConstructor[] = [];

  private _resource!: Resource;

  parameters!: K;

  get resource() {
    return this._resource as Resource & { details: T };
  }

  protected constructor() {}

  async onStart(): Promise<void> {}
  async onFinish(): Promise<void> {}
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async calculateScore(testResults: TestResult[]): Promise<number> {
    return 0;
  }

  /**
   * Creates a new Validation for the given Validator tag
   */
  static async create<K extends Record<string, unknown> = {}>(
    validatorTag: string,
    resource: Resource,
    sessionId: string,
    parameters?: K
  ) {
    const validation = new this();

    if (validation.tests.length == 0) {
      throw new Error("Please add at least one Test to the validation");
    }

    validation.logger = mainLogger.child({
      context: `Validator(${validatorTag}/${sessionId})`,
    });

    validation.parameters = parameters || {};
    validation.validatorTag = validatorTag;
    validation._resource = resource;
    validation.sessionId = sessionId;
    validation.pipe = config.validators[validatorTag].pipe;

    return validation;
  }

  /**
   * Starts the validation, executes all of the
   * defined Tests and their results.
   */
  async start(): Promise<TestResult[]> {
    const testResults: TestResult[] = [];

    const errorHandler = (methodName: string, err: unknown) => {
      const error = ensureError(err);
      this.logger.error(`Error in ${methodName}() method: ${error.stack}`);
    };

    await this.onStart().catch((err) => errorHandler("onStart", err));

    for (let i = 0; i < this.tests.length; i++) {
      const Test = this.tests[i];
      const testName = `${colorKeyword(Test.name)} (test ${i + 1})`;
      try {
        this.logger.info(`Starting ${testName}...`);
        const testInstance = new Test(this.validatorTag, this.sessionId);
        const testResult = await testInstance.execute(this);

        testResults.push(testResult);

        this.logger.info(`${testName} completed successfully`);
      } catch (err: unknown) {
        // If this is the termination error, re-throw it and interrupt the process, no need to continue
        if (isTermination(err)) {
          throw err;
        }

        const error = ensureError(err);
        this.logger.error(`Error while executing ${testName}: ${error.stack}`);
      }
    }
    await this.onFinish().catch((err) => errorHandler("onFinish", err));

    return testResults;
  }
}
