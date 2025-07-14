import { logger } from "@/core/logger";
import { Validator } from "@/core/validator";
import { Logger } from "winston";

/**
 * Abstract class to implement logic for uploading
 * audit files to a remote service.
 */
export abstract class AbstractUploader {
  logger: Logger;
  validator: Validator;

  constructor(validator: Validator) {
    this.logger = logger.child({
      context: this.constructor.name,
      validatorTag: validator.tag,
      validatorOwnerAddress: validator.actorInfo.ownerAddr.toLowerCase(),
    });
    this.validator = validator;
  }

  /**
   * Initializes the uploader, e.g., authenticating with a remote service.
   */
  abstract init(): Promise<void>;

  /**
   * Uploads audit files to a remote service.
   * @param auditFiles The audit files to upload.
   */
  abstract upload(auditFiles: UploadAuditFile[]): Promise<void>;

  /**
   * Finalizes the uploader, e.g., closing connections before exiting.
   */
  abstract close(): Promise<void>;
}

/**
 * Represents an audit file to be uploaded.
 */
export type UploadAuditFile = {
  commitHash: string;
  content: string;
};
