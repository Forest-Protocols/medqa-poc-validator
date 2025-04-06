import { DeploymentStatus } from "@forest-protocols/sdk";
import { Address, Hex } from "viem";

export const ThreadMessage = {
  ValidationCompleted: "VALIDATION_COMPLETED",
  PipeSend: "PIPE_SEND",
  PipeError: "PIPE_ERROR",
  PipeResponse: "PIPE_RESPONSE",
} as const;

export type ThreadMessageType =
  (typeof ThreadMessage)[keyof typeof ThreadMessage];

export type ThreadMessageObject<T = any> = {
  type: ThreadMessageType;
  data: T;
};

export type ValidatorConfiguration = {
  validatorWalletPrivateKey: Hex;
  billingWalletPrivateKey: Hex;
  operatorWalletPrivateKey: Hex;
};

export type ValidationResult = {
  score: number;
  testResults: TestResult[];
};

export type StructuredTestResults =
  | Record<string, unknown>
  | Array<Record<string, unknown>>
  | Array<unknown>;

export type TestResult<T extends StructuredTestResults = {}> = {
  /**
   * Is the Test completed successfully?
   */
  isSuccess: boolean;

  /**
   * Raw output
   */
  raw: string;

  /**
   * Machine readable structured output
   */
  result: T;

  /**
   * Name of the class that generated this result
   */
  testName: string;
};

// NOTE: This type can be moved to the SDK because it is a shared type between Provider daemon, Validator daemon and maybe CLI in the future
export type Resource = {
  id: number;
  name: string;
  deploymentStatus: DeploymentStatus;
  details: unknown;
  groupName: string;
  isActive: boolean;
  ownerAddress: Address;
  offerId: number;
  providerId: number;
  providerAddress: Address;
  operatorAddress: Address;
  ptAddress: Address;
};

export type MaybePromise<T> = T | Promise<T>;
