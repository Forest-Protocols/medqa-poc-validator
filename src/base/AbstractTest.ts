import { TestResult, StructuredTestResults } from "@/core/types";
import { logger as mainLogger } from "@/core/logger";
import { Logger } from "winston";
import { BaseValidation } from "./BaseValidation";

/**
 * Abstract class that all of the Tests have to inherit from.
 */
export abstract class AbstractTest<
  T extends StructuredTestResults = {},
  K extends BaseValidation = BaseValidation
> {
  logger: Logger;
  validatorTag: string;
  sessionId: string;

  constructor(validatorTag: string, sessionId: string) {
    this.logger = mainLogger.child({
      context: `${this.constructor.name}(${sessionId})`,
    });

    this.validatorTag = validatorTag;
    this.sessionId = sessionId;
  }

  /**
   * Implementation of how the Test will work
   * @param validation Validation object that includes information about the current validation such as Resource that going to be tested or other Tests that added to this validation.
   */
  abstract execute(validation: K): Promise<TestResult<T>>;

  /**
   * Test name in string
   */
  static get name() {
    return this.constructor.name;
  }

  /**
   * Test name in string
   */
  get name() {
    return this.constructor.name;
  }
}

export type AbstractTestConstructor<
  T extends StructuredTestResults = {},
  K extends BaseValidation = BaseValidation
> = new (...args: any[]) => AbstractTest<T, K>;
