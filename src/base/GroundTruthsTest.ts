import { StructuredTestResults } from "@/core/types";
import { BaseValidation } from "./BaseValidation";
import { AbstractTest } from "./AbstractTest";

/**
 * Base class for the tests which compares
 * the results with the ground truths.
 */
export abstract class GroundTruthsTest<
  T extends StructuredTestResults = {},
  K extends BaseValidation = BaseValidation
> extends AbstractTest<T, K> {
  /**
   * This class is just an alias for `AbstractTest`
   * for better code readability. The implementation should
   * be done by the derived class.
   */
}
