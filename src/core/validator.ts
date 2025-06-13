import {
  Actor,
  DECIMALS,
  DeploymentStatus,
  getContractAddressByChain,
  PipeError,
  PipeMethod,
  PipeResponseCode,
  Protocol,
  Registry,
  throttleRequest,
  Slasher,
  Status,
  TerminationError,
  USDCAddress,
  validateBodyOrParams,
  ValidatorDetails,
  writeContract,
  XMTPv3Pipe,
  Token,
  TimeoutError,
  stringifyJSON,
  generateCID,
  tryParseJSON,
  ProtocolDetails,
  ProviderDetails,
} from "@forest-protocols/sdk";
import {
  Account,
  Address,
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  erc20Abi,
  formatUnits,
  getContract,
  GetContractReturnType,
  Hex,
  PublicClient,
  WalletClient,
} from "viem";
import { config } from "./config";
import { privateKeyToAccount } from "viem/accounts";
import { rpcClient } from "./client";
import { logger as mainLogger } from "./logger";
import { Logger } from "winston";
import { colorHex, colorKeyword, colorNumber } from "./color";
import {
  AggregatedValidation,
  Resource,
  ValidationAuditFile,
  ValidatorConfiguration,
} from "./types";
import { ensureError } from "@/utils/ensure-error";
import { DB } from "@/database/client";
import { pipes } from "./pipe";
import { z } from "zod";
import { NotEnoughUSDCError as NotEnoughUSDCError } from "@/errors/NotEnoughUSDCError";
import { PromiseQueue } from "./queue";
import { abortController } from "./signal";
import { ResourceIsNotOnlineError } from "@/errors/ResourceIsNotOnlineError";
import { chunked } from "@/utils/array";
import { sleep } from "@/utils/sleep";
import { join } from "path";
import { isTermination } from "@/utils/is-termination";
import { availableUploaders } from "./uploader";
import { AbstractUploader } from "@/base/AbstractUploader";
import { groupArray } from "@/utils/group-array";

export class Validator {
  logger!: Logger;
  tag!: string;
  account!: Account;
  slasher!: Slasher;
  registry!: Registry;
  protocol!: Protocol;
  token!: Token;
  pipe!: XMTPv3Pipe;
  details!: ValidatorDetails;
  actorInfo!: Actor;
  usdc!: GetContractReturnType<typeof erc20Abi, PublicClient | WalletClient>;
  uploaders: AbstractUploader[] = [];
  providerNames: Record<number, string> = {};
  protocolName!: string;

  private rpcQueue = new PromiseQueue();
  private uploadCheckerInterval?: NodeJS.Timeout;
  private isUploadCheckerRunning = false;

  /**
   * Creates a new Validator instance for the given tag.
   */
  static async create(tag: string, valConfig: ValidatorConfiguration) {
    const validator = new Validator();

    validator.logger = mainLogger.child({
      context: `Validator(${tag})`,
    });
    validator.tag = tag;
    validator.account = privateKeyToAccount(
      valConfig.validatorWalletPrivateKey
    );
    validator.slasher = new Slasher({
      client: rpcClient,
      account: validator.account,
      address: config.SLASHER_ADDRESS,
      registryContractAddress: config.REGISTRY_ADDRESS,
      signal: abortController.signal,
    });
    validator.registry = new Registry({
      client: rpcClient,
      account: validator.account,
      address: config.REGISTRY_ADDRESS,
      signal: abortController.signal,
    });
    validator.protocol = new Protocol({
      client: rpcClient,
      address: config.PROTOCOL_ADDRESS,
      account: validator.account,
      registryContractAddress: config.REGISTRY_ADDRESS,
      signal: abortController.signal,
    });
    validator.token = new Token({
      client: rpcClient,
      address: config.TOKEN_ADDRESS,
      account: validator.account,
    });
    validator.usdc = getContract({
      abi: erc20Abi,
      address:
        config.USDC_ADDRESS ||
        getContractAddressByChain(config.CHAIN, USDCAddress),
      client: rpcClient,
    });

    await validator.initActorInfo();
    await validator.initPipe(valConfig.operatorWalletPrivateKey);

    // Get the Protocol name from the details file
    const protocolDetailsLink = await validator.protocol.getDetailsLink();
    const [protocolDetailsFile] = await DB.getDetailFiles([
      protocolDetailsLink,
    ]);

    if (!protocolDetailsFile) {
      throw new Error(
        "Protocol details file is not found. Please place the details file of the Protocol under 'data/details' directory"
      );
    }

    const protocolDetails = tryParseJSON<ProtocolDetails>(
      protocolDetailsFile.content
    );

    // TODO: Validate details schema

    if (!protocolDetails) {
      throw new Error("Invalid protocol details file.");
    }

    validator.protocolName = protocolDetails.name;

    if (config.CLOSE_AGREEMENTS_AT_STARTUP) {
      validator.logger.info("Closing previous Agreements");
      const agreements = await validator.protocol.getAllUserAgreements(
        validator.actorInfo.ownerAddr
      );
      const activeAgreements = agreements.filter(
        (agreement) => agreement.status === Status.Active
      );

      if (activeAgreements.length == 0) {
        validator.logger.info("No active Agreements found");
      }
      for (const agreement of activeAgreements) {
        await validator.closeAgreement(agreement.id);
      }
    }

    abortController.signal.addEventListener("abort", () => {
      validator.pipe?.close();
    });

    // Initialize available uploaders for this Validator
    for (const enabledUploader of config.ENABLED_UPLOADERS) {
      const Uploader = availableUploaders.find(
        (uploader) => uploader.name === `${enabledUploader}Uploader`
      );

      if (!Uploader) {
        validator.logger.warning(
          `Uploader ${enabledUploader} is not available, skipping...`
        );
        continue;
      }

      // Check if the uploader is already initialized
      if (validator.uploaders.some((u) => u instanceof Uploader)) {
        validator.logger.info(
          `Uploader ${enabledUploader} is already initialized, skipping...`
        );
        continue;
      }

      validator.logger.info(`Initializing uploader: ${enabledUploader}`);

      const uploader = new Uploader(validator);
      await uploader.init();
      validator.uploaders.push(uploader);
    }

    // At startup check the uploads then start the interval for continuous checking
    validator.checkUploads().then(() => {
      validator.uploadCheckerInterval = setInterval(
        () => validator.checkUploads(),
        config.UPLOAD_CHECKER_INTERVAL
      );
    });

    return validator;
  }

  async closeEpoch() {
    await this.rpcQueue.queue(() => this.slasher.closeEpoch());
  }

  async emitRewards(epochEndBlockNumber: bigint) {
    await this.rpcQueue.queue(() =>
      this.token.emitRewards(epochEndBlockNumber)
    );
  }

  async checkExistingValidationsToBeUploaded() {
    // Check the existence of the corresponding uploads for validations in the database
    const revealedValidations = await DB.getRevealedValidations(
      this.actorInfo.id
    );
    const uploads = await DB.getUploadsForRevealedValidations(
      this.actorInfo.id,
      revealedValidations.map((v) => v.commitHash!)
    );

    // Find the revealed validations that doesn't have corresponding uploads
    const unuploadedRevealedValidations = revealedValidations.filter(
      (v) => !uploads.some((u) => u.commitHash === v.commitHash)
    );

    if (unuploadedRevealedValidations.length == 0) {
      this.logger.debug(`No unuploaded revealed validations found`);
      return;
    }

    // Group validations based on their hashes
    const groupedValidations = groupArray(
      unuploadedRevealedValidations,
      (v) => v.commitHash!
    );

    // Add those validations to the uploads table so the upload checker will upload them
    for (const [commitHash, validations] of Object.entries(
      groupedValidations
    )) {
      try {
        // Sort the validations to have consistent CID
        this.sortValidations(validations);

        const { stringifiedData, detailsLink } =
          await this.buildAuditFileObject(commitHash as Hex, validations);

        // Add upload records for each uploader
        for (const uploader of this.uploaders) {
          await DB.addUploadRecord(
            stringifiedData,
            uploader.constructor.name,
            this.actorInfo.id,
            commitHash as Hex,
            detailsLink
          );

          this.logger.info(
            `Added upload record for commit ${colorHex(commitHash)} via  ${
              uploader.constructor.name
            }. It'll be processed by the upload checker.`
          );
        }
      } catch (err: unknown) {
        const error = ensureError(err);
        this.logger.error(
          `Error while adding upload records for revealed validations: ${error.stack}`
        );
      }
    }
  }

  async checkUploads() {
    // If there is already a checkUploads() call running, skip the current call
    if (this.isUploadCheckerRunning) {
      return;
    }

    this.isUploadCheckerRunning = true;
    this.logger.info(`Checking uploads...`);

    try {
      // Check if all of the validations have corresponding upload records on the database.
      await this.checkExistingValidationsToBeUploaded();

      const toBeUploaded = await DB.getUploads(this.actorInfo.id, false);
      if (toBeUploaded.length == 0) {
        this.logger.info(`No data found to upload`);
        this.isUploadCheckerRunning = false;
        return;
      }

      // Upload the data via uploaders that defined for this Validator
      for (const upload of toBeUploaded) {
        // No need to continue if the abort signal is received
        this.checkAbort();

        const uploader = this.uploaders.find(
          (u) => u.constructor.name === upload.uploadedBy
        );
        if (!uploader) {
          this.logger.warning(
            `Uploader ${upload.uploadedBy} not found inside Validator(${this.tag}), skipping...`
          );
          continue;
        }

        try {
          await uploader.upload([
            {
              commitHash: upload.commitHash,
              content: upload.content,
            },
          ]);
          await DB.markAsUploaded(
            upload.cid,
            upload.commitHash,
            this.actorInfo.id
          );
          this.logger.info(
            `Data of ${colorHex(upload.commitHash)} uploaded with ${
              uploader.constructor.name
            }`
          );
        } catch (err: unknown) {
          const error = ensureError(err);
          this.logger.error(
            `Error while uploading data to ${uploader.constructor.name}: ${error.stack}`
          );
        }
      }
    } catch (err: unknown) {
      const error = ensureError(err);
      this.logger.error(`Error while checking uploads: ${error.stack}`);
    } finally {
      this.isUploadCheckerRunning = false;
    }
  }

  /**
   * Commits validations to the blockchain
   */
  async commitValidations() {
    await this.rpcQueue.queue(async () => {
      try {
        // If the last Epoch is closed that means we are in the new Epoch's Commit Window
        // so we can commit new results to the blockchain
        const isLastEpochClosed = await this.slasher.isLastEpochClosed();

        if (!isLastEpochClosed) {
          return;
        }

        const uncommittedValidations = await DB.getUncommittedValidations(
          this.actorInfo.id
        );

        // If there are enough validations then we are going to commit them
        if (uncommittedValidations.length < config.MAX_VALIDATION_TO_COMMIT) {
          return;
        }

        this.logger.info(`Scores are committing to the blockchain...`);
        await chunked(
          config.MAX_VALIDATION_TO_COMMIT,
          uncommittedValidations,
          async (chunk) => {
            // Check abort in each chunk if termination signal is received
            // It will break the whole chunked() call if something is thrown
            this.checkAbort();

            if (chunk.length !== config.MAX_VALIDATION_TO_COMMIT) {
              // This chunk doesn't have enough validations to commit according to the config,
              // (it might be the last chunk) so we need to skip it
              return;
            }

            try {
              // Sort the chunk to have consistent commitHash
              this.sortValidations(chunk);

              this.logger.debug(
                `Commit Results Chunk: ${JSON.stringify(
                  chunk.map((validation) => ({
                    agreementId: validation.agreementId,
                    provId: validation.providerId,
                    score: BigInt(validation.score),
                  })),
                  null,
                  2
                )}`
              );

              // Compute the hash of the chunk
              const hash = await this.slasher.computeHash(
                chunk.map((validation) => ({
                  agreementId: validation.agreementId,
                  provId: validation.providerId,
                  score: BigInt(validation.score),
                }))
              );

              // Get details link of the audit file data
              const { detailsLink, stringifiedData } =
                await this.buildAuditFileObject(hash, chunk);

              // Commit them to the blockchain
              await this.slasher.commitResult(
                hash,
                this.actorInfo.ownerAddr,
                config.PROTOCOL_ADDRESS,
                detailsLink
              );

              // Set commit hash of the relevant validations in the database to
              // keep track of whether they are committed or not.
              await DB.setCommitHash(
                chunk.map((validation) => validation.sessionId),
                hash
              );

              this.logger.info(
                `${
                  chunk.length
                } validations are committed to the blockchain (commit hash: ${colorHex(
                  hash
                )}, detailsLink: ${colorKeyword(detailsLink)})`
              );

              // Log data for debugging
              this.logger.debug(
                `JSON.stringify chunk and stringifiedData data for commit hash ${colorHex(
                  hash
                )}:\nchunk: ${JSON.stringify(
                  chunk,
                  null,
                  2
                )}\n\nstringifiedData: ${stringifiedData}`
              );
            } catch (err: unknown) {
              if (isTermination(err)) {
                // Re-throw for outer catch block
                throw err;
              }

              const error = ensureError(err);
              this.logger.error(
                `Error while committing scores to the blockchain: ${error.stack}`
              );
            }
          }
        );
      } catch (err: unknown) {
        if (isTermination(err)) {
          return;
        }

        const error = ensureError(err);
        this.logger.error(
          `Error while committing scores to the blockchain: ${error.stack}`
        );
      }
    });
  }

  checkAbort() {
    if (abortController.signal.aborted) {
      throw new TerminationError();
    }
  }

  async revealResults() {
    await this.rpcQueue.queue(async () => {
      try {
        const unrevealedValidations = await DB.getUnrevealedValidations(
          this.actorInfo.id
        );
        if (unrevealedValidations.length == 0) {
          return;
        }

        this.logger.info(
          `Revealing ${unrevealedValidations.length} results...`
        );

        // Group validations based on their hashes because we need to reveal
        // the validations that has the same hash at once.
        const groupedValidations = groupArray(
          unrevealedValidations,
          (v) => v.commitHash!
        );

        for (const [commitHash, validations] of Object.entries(
          groupedValidations
        )) {
          this.checkAbort();
          try {
            // To make commit hash consistent, sort the array just
            // like we did when we were committing them. Otherwise
            // if the items of the array are in different positions
            // the hash will be different.
            this.sortValidations(validations);

            this.logger.debug(
              `Reveal Chunk with hash ${colorHex(commitHash)}: ${JSON.stringify(
                validations.map((validation) => ({
                  agreementId: validation.agreementId,
                  provId: validation.providerId,
                  score: BigInt(validation.score),
                })),
                null,
                2
              )}`
            );

            // Generate audit file data
            const { auditFile, stringifiedData, detailsLink } =
              await this.buildAuditFileObject(commitHash as Hex, validations);

            // Call uploaders with the results
            for (const uploader of this.uploaders) {
              try {
                // Save the data to be uploaded
                const uploadData = await DB.addUploadRecord(
                  stringifiedData,
                  uploader.constructor.name,
                  this.actorInfo.id,
                  auditFile.commitHash as Hex,
                  detailsLink
                );

                // Upload the data
                await uploader.upload([
                  {
                    commitHash: auditFile.commitHash,
                    content: stringifiedData,
                  },
                ]);

                // Mark the data as uploaded. If the upload was failed, the workflow won't reach
                // at this line and this upload will be processed again by the upload checker (`this.checkUploads()`).
                await DB.markAsUploaded(
                  uploadData.cid,
                  auditFile.commitHash as Hex,
                  this.actorInfo.id
                );

                this.logger.info(
                  `Audit file of ${colorHex(auditFile.commitHash)} (including ${
                    auditFile.data.length
                  } sessions, detailsLink: ${colorKeyword(
                    detailsLink
                  )}) uploaded with ${uploader.constructor.name}`
                );

                // Log data for debugging
                this.logger.debug(
                  `JSON.stringify validations and stringifiedData data for commit hash ${colorHex(
                    auditFile.commitHash
                  )}\nvalidations: ${JSON.stringify(
                    validations,
                    null,
                    2
                  )}\n\nstringifiedData: ${stringifiedData}`
                );
              } catch (err: unknown) {
                const error = ensureError(err);
                this.logger.error(
                  `Error while uploading results of ${colorHex(
                    auditFile.commitHash
                  )} (detailsLink: ${colorKeyword(detailsLink)}) with ${
                    uploader.constructor.name
                  }: ${error.stack}`
                );
              }
            }

            // Reveal the results to the blockchain
            await this.slasher.revealResult(
              commitHash as Hex,
              this.actorInfo.ownerAddr,
              config.PROTOCOL_ADDRESS,
              validations.map((validation) => ({
                agreementId: validation.agreementId,
                provId: validation.providerId,
                score: BigInt(validation.score),
              }))
            );

            this.logger.info(
              `${
                validations.length
              } validations are revealed (commit hash: ${colorHex(commitHash)})`
            );

            // Mark validations as revealed in the database
            await DB.markAsRevealed(commitHash as Hex);
          } catch (err: unknown) {
            if (isTermination(err)) {
              return;
            }

            const error = ensureError(err);

            /**
             * If the error was thrown because we were too late to reveal
             * the commit hash, then mark the commit hash as vanished so
             * we won't try to reveal it again.
             */
            if (
              error instanceof ContractFunctionExecutionError &&
              error.cause instanceof ContractFunctionRevertedError &&
              error.cause.reason?.includes("Array index is out of bounds")
            ) {
              this.logger.warning(
                `The commit ${colorHex(
                  commitHash
                )} is vanished and cannot be revealed anymore, skipping...`
              );
              await DB.markAsVanished(commitHash as Hex);
            } else {
              this.logger.error(
                `Error while trying to reveal ${
                  validations.length
                } validations (commit hash: ${colorHex(commitHash)}): ${
                  error.stack
                }`
              );
            }
          }
        }
      } catch (err) {
        if (isTermination(err)) {
          return;
        }

        const error = ensureError(err);
        this.logger.error(
          `Error while trying to reveal results: ${error.stack}`
        );
      }
    });
  }

  /**
   * Checks the USDC allowance and increases it if not enough
   * then enters a new Agreement with the given Offer ID.
   * @returns An object that includes Agreement ID and Operator address of the Provider
   */
  async enterAgreement(offerId: number, sessionId = "") {
    return await this.rpcQueue.queue(async () => {
      this.checkAbort();
      const loggerOptions = this.createLoggerOptions(sessionId);
      const offer = await this.protocol.getOffer(offerId);
      const provider = (await this.registry.getActor(offer.ownerAddr))!;
      const minDeposit = 2n * 2635200n * offer.fee;
      const revenueShare = await this.registry.getRevenueShare();
      const networkFee = (minDeposit * revenueShare) / 10000n; // 10000 is hundred percent points
      const totalCost = minDeposit + networkFee;
      const [balance, ptAllowance] = await Promise.all([
        throttleRequest(
          () => this.usdc.read.balanceOf([this.account.address]),
          { signal: abortController.signal }
        ),
        throttleRequest(
          () =>
            this.usdc.read.allowance([
              this.account.address,
              config.PROTOCOL_ADDRESS,
            ]),
          { signal: abortController.signal }
        ),
      ]);
      const formattedBalance = formatUnits(balance, DECIMALS.USDC);

      // Update the cache with the Provider name
      await this.getProviderName(provider);

      this.logger.info(
        `Current USDC balance: ${formattedBalance}`,
        loggerOptions
      );

      // Check balance
      if (balance < totalCost) {
        const formattedDeposit = formatUnits(totalCost, DECIMALS.USDC);
        throw new NotEnoughUSDCError(formattedBalance, formattedDeposit);
      }

      // Check allowance and increase if it's not enough
      if (ptAllowance < totalCost) {
        const formattedAmount = formatUnits(totalCost, DECIMALS.USDC);
        this.logger.info(
          `USDC allowance is setting (to ${formattedAmount} USDC)`,
          loggerOptions
        );

        const { request } = await throttleRequest(
          () =>
            rpcClient.simulateContract({
              abi: this.usdc.abi,
              address: this.usdc.address,
              functionName: "approve",
              account: this.account,
              args: [config.PROTOCOL_ADDRESS, totalCost],
            }),
          { signal: abortController.signal }
        );

        await writeContract(rpcClient, request, {
          onContractWrite: (hash) => {
            this.logger.debug(
              `USDC Allowance TX hash: ${colorHex(hash)}`,
              loggerOptions
            );
          },
        });
      }

      this.logger.info(
        `Entering a new Agreement with Offer ${colorNumber(offerId)}`,
        loggerOptions
      );

      this.checkAbort();
      const agreementId = await this.protocol.enterAgreement(
        offerId,
        minDeposit
      );

      this.logger.info(
        `Entered a new Agreement with ID ${colorNumber(
          agreementId
        )}, waiting for the Resource to be online...`,
        loggerOptions
      );

      return { agreementId, operatorAddress: provider.operatorAddr };
    });
  }

  /**
   * Checks the Resource status of the given Agreement
   * in an interval until it is being in Running state.
   */
  async waitResourceToBeOnline(
    agreementId: number,
    operatorAddress: Address,
    sessionId = ""
  ): Promise<Resource> {
    const startTs = Date.now();
    const loggerOptions = this.createLoggerOptions(sessionId);

    while (!abortController.signal.aborted) {
      const currentTs = Date.now();
      const passedTime = currentTs - startTs;

      // If Resource took much time to be online than we expected, cancel the validation.
      if (passedTime >= config.TIMEOUT_RESOURCE_TO_BE_ONLINE) {
        throw new ResourceIsNotOnlineError(agreementId);
      }
      try {
        this.logger.debug(
          `Sending get Resource request for ${colorNumber(
            agreementId
          )} to ${colorHex(operatorAddress)}`
        );

        // Retrieve details of the Resource
        const response = await this.pipe.send(operatorAddress, {
          method: PipeMethod.GET,
          path: "/resources",
          params: {
            id: agreementId,
            pt: config.PROTOCOL_ADDRESS,

            // TODO: Remove in the next versions, just for backward compatibility
            pc: config.PROTOCOL_ADDRESS,
          },
          timeout: 15 * 1000,
        });

        this.logger.debug(
          `Get Resource request  for ${colorNumber(
            agreementId
          )} has been sent to ${colorHex(operatorAddress)}`
        );

        if (response.code != PipeResponseCode.OK) {
          throw new PipeError(response.code, response.body);
        }
        const resource = response?.body;

        if (resource) {
          if (resource.deploymentStatus === DeploymentStatus.Running) {
            this.logger.info(
              `Resource of Agreement ${colorNumber(agreementId)} is online`,
              loggerOptions
            );
            resource.operatorAddress = operatorAddress;
            return resource;
          } else if (resource.deploymentStatus === DeploymentStatus.Failed) {
            throw new Error(
              `Deployment of Resource ${colorNumber(resource.id)} is failed`
            );
          }
        }
      } catch (err: unknown) {
        const error = ensureError(err);
        if (error instanceof PipeError) {
          // Ignore not found errors. We just need to wait a little bit more
          // until the Provider picks up the creation event from the blockchain
          if (error.code !== PipeResponseCode.NOT_FOUND) {
            this.logger.warning(
              `Couldn't retrieve details of Agreement ${colorNumber(
                agreementId
              )}: ${error.stack}`,
              loggerOptions
            );
          }

          // Ignore timeout errors since we have our timeout
        } else if (!(error instanceof TimeoutError)) {
          throw err;
        }
      }

      await sleep(1000);
    }

    throw new TerminationError();
  }

  /**
   * Closes the given Agreement
   */
  async closeAgreement(agreementId: number, sessionId = "") {
    await this.rpcQueue.queue(async () => {
      this.logger.info(
        `Closing Agreement ${colorNumber(agreementId)}`,
        this.createLoggerOptions(sessionId)
      );

      // We might get an abort signal, in that case the global
      // rpc client will stop working so we need to create another
      // one in order to close opened agreements
      const protocol = new Protocol({
        rpcHost: config.RPC_HOST,
        chain: config.CHAIN,
        account: this.account,
        registryContractAddress: config.REGISTRY_ADDRESS,
        address: config.PROTOCOL_ADDRESS,
      });

      await protocol.closeAgreement(agreementId);

      this.logger.info(
        `Agreement ${colorNumber(agreementId)} closed`,
        this.createLoggerOptions(sessionId)
      );
    }, true);
  }

  /**
   * Finalizes the current works from the queue and closes Pipe.
   */
  async clean() {
    if (this.uploadCheckerInterval) {
      clearInterval(this.uploadCheckerInterval);
    }

    await this.rpcQueue.waitUntilEmpty();
    await this.pipe.close();

    for (const uploader of this.uploaders) {
      try {
        await uploader.close();
        this.logger.info(`Uploader ${uploader.constructor.name} closed`);
      } catch (err: unknown) {
        const error = ensureError(err);
        this.logger.error(
          `Error while closing uploader ${uploader.constructor.name}: ${error.stack}`
        );
      }
    }

    this.logger.debug(`Cleaned!`);
  }

  private async getProviderName(providerOrId: number | Actor) {
    const providerId =
      typeof providerOrId === "number" ? providerOrId : providerOrId.id;

    if (this.providerNames[providerId] === undefined) {
      this.logger.info(`Getting details of the Provider ${providerId}`);

      const provider =
        typeof providerOrId === "number"
          ? await this.registry.getActor(providerId)
          : providerOrId;

      const response = await this.pipe.send(provider!.operatorAddr, {
        method: PipeMethod.GET,
        path: "/details",
        body: [provider!.detailsLink],
        timeout: 15_000, // 15 seconds
      });

      if (response.code !== PipeResponseCode.OK) {
        this.logger.error(
          `Error while getting details of the Provider ${
            provider!.id
          } (${colorHex(provider!.ownerAddr)})`
        );
        throw new PipeError(response.code, response.body);
      }

      const [detailsFileContent] = response.body;
      const details = tryParseJSON<ProviderDetails>(detailsFileContent);

      if (!details) {
        throw new Error(
          `Invalid details file of the Provider ${provider!.id} (${colorHex(
            provider!.ownerAddr
          )})`
        );
      }

      // TODO: Validate the details

      this.providerNames[provider!.id] = details.name;
    }

    return this.providerNames[providerId];
  }

  private async buildAuditFileObject(
    commitHash: Hex,
    validations: AggregatedValidation[]
  ) {
    const auditFile: ValidationAuditFile = {
      commitHash,
      data: await Promise.all(
        validations.map(async (v) => ({
          sessionId: v.sessionId,
          validatorId: v.validatorId,
          startedAt: v.startedAt,
          finishedAt: v.finishedAt,
          score: v.score,
          agreementId: v.agreementId,
          offerId: v.offerId,
          providerId: v.providerId,

          // We need to sort the test results to have deterministic CID calculation.
          // Test names might be the same, that's why we are sorting them based on
          // their stringified versions. This approach is undeniably deterministic
          // since we are using `stringifyJSON` which produces deterministic output
          // and that result cannot be exactly the same for two different objects.
          // Even if the results are the same, the order of the objects won't make any difference
          testResults: [...v.testResults].sort((a, b) => {
            const stringifiedA = stringifyJSON(a.result as any)!;
            const stringifiedB = stringifyJSON(b.result as any)!;

            return stringifiedA.localeCompare(stringifiedB);
          }),

          providerName: await this.getProviderName(v.providerId),
          protocol: {
            name: this.protocolName,
            address: config.PROTOCOL_ADDRESS,
          },
        }))
      ),
    };
    const stringifiedData = stringifyJSON(auditFile.data)!;
    const detailsLink = (await generateCID(stringifiedData)).toString();

    return {
      auditFile,
      stringifiedData,
      detailsLink,
    };
  }

  /**
   * Creates logger options (this includes context of the log)
   */
  private createLoggerOptions(sessionId = "") {
    if (sessionId != "") sessionId = `/${sessionId}`;

    return { context: `Validator(${this.tag}${sessionId})` };
  }

  private sortValidations(validations: { agreementId: number }[]) {
    validations.sort((a, b) =>
      a.agreementId < b.agreementId ? -1 : a.agreementId > b.agreementId ? 1 : 0
    );
  }

  private async initPipe(operatorPrivateKey: Hex) {
    // If there is no Pipe instance for this operator, instantiate one
    if (!pipes[this.actorInfo.operatorAddr]) {
      this.pipe = new XMTPv3Pipe(operatorPrivateKey, {
        signal: abortController.signal,
        dbPath: join(
          process.cwd(),
          "data",
          `db-${this.actorInfo.operatorAddr}.db`
        ),

        // Doesn't matter what it is as long as it is something that we can use in the next client initialization
        encryptionKey: this.actorInfo.operatorAddr,
      });

      await this.pipe.init(config.NODE_ENV);

      // Setup routes
      this.pipe.route(PipeMethod.GET, "/details", async (req) => {
        this.logger.info(`Got Pipe request on /details with ID ${req.id}`);

        const body = validateBodyOrParams(req.body, z.array(z.string()).min(1));
        const files = await DB.getDetailFiles(body);

        if (files.length == 0) {
          throw new PipeError(PipeResponseCode.NOT_FOUND, {
            message: "Detail files are not found",
          });
        }

        return {
          code: PipeResponseCode.OK,
          body: files.map((file) => file.content),
        };
      });

      if (!abortController.signal.aborted) {
        this.logger.info(
          `Operator ${colorHex(this.actorInfo.operatorAddr)} initialized`
        );
      }
    } else {
      this.pipe = pipes[this.actorInfo.operatorAddr];
    }
  }

  private async initActorInfo() {
    const actorInfo = await this.registry.getActor(this.account.address);

    if (!actorInfo) {
      throw new Error(
        `Validator "${this.tag}" (${colorHex(
          this.account.address
        )}) is not registered in the Network. Please try to register it and restart the daemon.`
      );
    }

    this.actorInfo = actorInfo;

    const { detailsFile } = await DB.upsertValidator(
      actorInfo.id,
      actorInfo.detailsLink,
      actorInfo.ownerAddr
    );

    try {
      this.details = JSON.parse(detailsFile);
      // TODO: Validate schema
    } catch {
      // TODO: Handle error
    }
  }

  private constructor() {}
}
