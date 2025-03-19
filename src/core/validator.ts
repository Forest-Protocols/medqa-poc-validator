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
  XMTPPipe,
  Token,
} from "@forest-protocols/sdk";
import {
  Account,
  Address,
  erc20Abi,
  formatUnits,
  getContract,
  GetContractReturnType,
  Hex,
  nonceManager,
  PublicClient,
  WalletClient,
} from "viem";
import { config } from "./config";
import { privateKeyToAccount } from "viem/accounts";
import { rpcClient } from "./client";
import { logger as mainLogger } from "./logger";
import { Logger } from "winston";
import { colorHex, colorNumber } from "./color";
import { Resource, ValidatorConfiguration } from "./types";
import { ensureError } from "@/utils/ensure-error";
import { DB } from "@/database/client";
import { pipes } from "./pipe";
import { z } from "zod";
import { DbValidation } from "@/database/schema";
import { NotEnoughUSDCError as NotEnoughUSDCError } from "@/errors/NotEnoughUSDCError";
import { PromiseQueue } from "./queue";
import { abortController, isTermination } from "./signal";
import { ResourceIsNotOnlineError } from "@/errors/ResourceIsNotOnlineError";
import { chunked } from "@/utils/array";
import { sleep } from "@/utils/sleep";

export class Validator {
  logger!: Logger;
  tag!: string;
  account!: Account;
  slasher!: Slasher;
  registry!: Registry;
  protocol!: Protocol;
  token!: Token;
  pipe!: XMTPPipe;
  details!: ValidatorDetails;
  actorInfo!: Actor;
  usdc!: GetContractReturnType<typeof erc20Abi, PublicClient | WalletClient>;

  // nonce is already managed by Viem but it doesn't enough
  // for enter Agreement process. That's why we simply split
  // Agreement and result related stuff into two different queue.
  private commitRevealQueue = new PromiseQueue();
  private agreementQueue = new PromiseQueue();

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
      valConfig.validatorWalletPrivateKey,
      { nonceManager }
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

    return validator;
  }

  async closeEpoch() {
    await this.commitRevealQueue.add(() => this.slasher.closeEpoch());
  }

  async emitRewards(epochEndBlockNumber: bigint) {
    await this.commitRevealQueue.add(() =>
      this.token.emitRewards(epochEndBlockNumber)
    );
  }

  /**
   * Commits validations to the blockchain
   */
  async commitValidations() {
    await this.commitRevealQueue.add(async () => {
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

        // If there are enough validations we are going to commit them
        if (uncommittedValidations.length < config.MAX_VALIDATION_TO_COMMIT) {
          return;
        }

        this.logger.info(`Scores are committing to the blockchain...`);
        await chunked(
          config.MAX_VALIDATION_TO_COMMIT,
          uncommittedValidations,
          async (chunk) => {
            // Check abort in each chunk
            // It will break the whole chunked() call if aborted
            this.checkAbort();
            try {
              chunk.sort((a, b) =>
                a.agreementId < b.agreementId
                  ? -1
                  : a.agreementId > b.agreementId
                  ? 1
                  : 0
              );

              const hash = await this.slasher.computeHash(
                chunk.map((validation) => ({
                  agreementId: validation.agreementId,
                  provId: validation.providerId,
                  score: BigInt(validation.score),
                }))
              );

              await this.slasher.commitResult(
                hash,
                this.actorInfo.ownerAddr,
                config.PROTOCOL_ADDRESS
              );

              // Save the commit hash to the database
              await DB.setCommitHash(
                chunk.map((validation) => validation.sessionId),
                hash
              );
              this.logger.info(
                `Hash (${colorHex(hash)}) of ${
                  chunk.length
                } validations is committed to the blockchain`
              );
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
        this.logger.info("Results committed to the blockchain");
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
    await this.commitRevealQueue.add(async () => {
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
        const groupedValidations: Record<Hex, DbValidation[]> = {};
        for (const unrevealedValidation of unrevealedValidations) {
          if (
            groupedValidations[unrevealedValidation.commitHash!] === undefined
          ) {
            groupedValidations[unrevealedValidation.commitHash!] = [];
          }

          groupedValidations[unrevealedValidation.commitHash!].push(
            unrevealedValidation
          );
        }

        for (const [commitHash, validations] of Object.entries(
          groupedValidations
        )) {
          this.checkAbort();
          try {
            // To make commit hash consistent, sort the array just
            // like we did when we were committing them. Otherwise
            // if the items of the array are in different positions
            // the hash will be different.
            validations.sort((a, b) =>
              a.agreementId < b.agreementId
                ? -1
                : a.agreementId > b.agreementId
                ? 1
                : 0
            );

            this.logger.debug(
              `Reveal Chunk: ${JSON.stringify(
                validations.map((validation) => ({
                  agreementId: validation.agreementId,
                  provId: validation.providerId,
                  score: BigInt(validation.score),
                })),
                null,
                2
              )}`
            );
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
            await DB.markAsRevealed(commitHash as Hex);
            this.logger.info(
              `${
                validations.length
              } validations are revealed (commit hash: ${colorHex(commitHash)})`
            );
          } catch (err: unknown) {
            if (isTermination(err)) {
              return;
            }

            const error = ensureError(err);
            this.logger.error(
              `Error while trying to reveal ${
                validations.length
              } validations (commit hash: ${colorHex(commitHash)}): ${
                error.stack
              }`
            );
          }
        }
        this.logger.info("Reveal done");
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
    return await this.agreementQueue.add(async () => {
      this.checkAbort();
      const loggerOptions = this.createLoggerOptions(sessionId);
      const offer = await this.protocol.getOffer(offerId);
      const provider = (await this.registry.getActor(offer.ownerAddr))!;
      const initialDeposit = offer.fee * 2n * 2635200n;
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

      this.logger.info(
        `Current USDC balance: ${formattedBalance}`,
        loggerOptions
      );

      // Check balance
      if (balance < initialDeposit) {
        const formattedDeposit = formatUnits(initialDeposit, DECIMALS.USDC);
        throw new NotEnoughUSDCError(formattedBalance, formattedDeposit);
      }

      // Check allowance and increase if it's not enough
      if (ptAllowance < initialDeposit) {
        const amount = initialDeposit - ptAllowance;
        const formattedAmount = formatUnits(amount, DECIMALS.USDC);
        this.logger.info(
          `USDC allowance is increasing (${formattedAmount} USDC)`,
          loggerOptions
        );

        const { request } = await throttleRequest(
          () =>
            rpcClient.simulateContract({
              abi: this.usdc.abi,
              address: this.usdc.address,
              functionName: "approve",
              account: this.account,
              args: [config.PROTOCOL_ADDRESS, amount],
            }),
          { signal: abortController.signal }
        );

        await writeContract(rpcClient, request, {
          retryDelay: 2_000,
          timeout: 25_000,
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
        initialDeposit
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
      const passedSeconds = Math.floor((currentTs - startTs) / 1000);

      // If Resource took much time to be online than we expected, cancel the validation.
      if (passedSeconds >= config.TIMEOUT_RESOURCE_TO_BE_ONLINE) {
        throw new ResourceIsNotOnlineError(agreementId);
      }
      try {
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

        if (response.code != PipeResponseCode.OK) {
          throw new PipeError(response.code, response.body);
        }
        const resource = response?.body;

        if (resource?.deploymentStatus == DeploymentStatus.Running) {
          this.logger.info(
            `Resource of Agreement ${colorNumber(agreementId)} is online`,
            loggerOptions
          );
          resource.operatorAddress = operatorAddress;
          return resource;
        }
      } catch (err: unknown) {
        const error = ensureError(err);
        if (error instanceof PipeError) {
          this.logger.warning(
            `Couldn't retrieve details of Agreement ${colorNumber(
              agreementId
            )}: ${error.stack}`,
            loggerOptions
          );
        } else {
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
    await this.agreementQueue.add(async () => {
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
   * Creates logger options (this includes context of the log)
   */
  private createLoggerOptions(sessionId = "") {
    if (sessionId != "") sessionId = `/${sessionId}`;

    return { context: `Validator(${this.tag}${sessionId})` };
  }

  private async initPipe(operatorPrivateKey: Hex) {
    // If there is no Pipe instance for this operator, instantiate one
    if (!pipes[this.actorInfo.operatorAddr]) {
      this.pipe = new XMTPPipe(operatorPrivateKey);

      // Disable `console.info` to get rid out of XMTP dev message
      const consoleInfo = console.info;
      console.info = () => {};
      await this.pipe.init(config.CHAIN == "optimism" ? "production" : "dev");
      console.info = consoleInfo;

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
