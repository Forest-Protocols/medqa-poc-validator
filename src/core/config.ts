import { z } from "zod";
import { blue, red } from "ansis";
import {
  addressSchema,
  ForestRegistryAddress,
  ForestSlasherAddress,
  ForestTokenAddress,
  getContractAddressByChain,
  privateKeySchema,
  setGlobalRateLimit,
  USDCAddress,
} from "@forest-protocols/sdk";
import { Address } from "viem";
import { isMainThread } from "worker_threads";
import { Validator } from "./validator";
import { ValidatorConfiguration } from "./types";
import dotenv from "@dotenvx/dotenvx";
import { readableTime } from "@/utils/readable-time";
import { parseTime } from "@/utils/parse-time";

if (isMainThread) {
  dotenv.config({ ignore: ["MISSING_ENV_FILE"] });
}

const nonEmptyStringSchema = z.string().nonempty("Shouldn't be empty");

function parseValidatorConfigurations() {
  const validatorSchema = z.object({
    validatorWalletPrivateKey: privateKeySchema,
    billingWalletPrivateKey: privateKeySchema,
    operatorWalletPrivateKey: privateKeySchema,
  });

  const validatorConfigurations: Record<string, ValidatorConfiguration> = {};

  // Parse private keys of the Validators
  const regex = /^(VALIDATOR|BILLING|OPERATOR)_PRIVATE_KEY_([\w]+)$/;
  for (const [name, value] of Object.entries(process.env)) {
    const match = name.match(regex);
    if (match) {
      const keyType = match[1];
      const providerTag = match[2];

      if (!validatorConfigurations[providerTag]) {
        validatorConfigurations[providerTag] = {
          billingWalletPrivateKey: "0x",
          operatorWalletPrivateKey: "0x",
          validatorWalletPrivateKey: "0x",
        };
      }

      switch (keyType) {
        case "VALIDATOR":
          validatorConfigurations[providerTag].validatorWalletPrivateKey =
            value as Address;
          break;
        case "OPERATOR":
          validatorConfigurations[providerTag].operatorWalletPrivateKey =
            value as Address;
          break;
        case "BILLING":
          validatorConfigurations[providerTag].billingWalletPrivateKey =
            value as Address;
          break;
      }
    }
  }

  for (const [validatorTag, keys] of Object.entries(validatorConfigurations)) {
    const validation = validatorSchema.safeParse(keys);

    if (validation.error) {
      const error = validation.error.errors[0];
      console.error(
        red(
          `Invalid Validator configuration for tag "${validatorTag}": ${error.path}: ${error.message}`
        )
      );
      process.exit(1);
    }
  }

  return validatorConfigurations;
}

function parseEnvVariables() {
  if (isMainThread) {
    console.log(blue.bold("[INFO] Parsing environment variables"));
  }

  const environmentSchema = z
    .object({
      NODE_ENV: z.enum(["dev", "production"]).default("dev"),
      LOG_LEVEL: z.enum(["error", "warning", "info", "debug"]).default("debug"),
      DATABASE_URL: nonEmptyStringSchema,
      RPC_HOST: nonEmptyStringSchema,
      CHAIN: z.enum(["anvil", "optimism", "optimism-sepolia"]).default("anvil"),
      PROTOCOL_ADDRESS: addressSchema,
      MAX_CONCURRENT_VALIDATION: z.coerce.number().default(1),
      EVALUATION_WAIT_TIME: z
        .string()
        .default("5m")
        .transform((value, ctx) => parseTime(value, ctx)),
      TIMEOUT_RESOURCE_TO_BE_ONLINE: z
        .string()
        .transform((value, ctx) => parseTime(value, ctx)),
      LISTEN_BLOCKCHAIN: z.string().transform((value) => {
        const result = value === "true";

        if (result && isMainThread) {
          console.log(blue.bold("[INFO] Blockchain listener is enabled"));
        }

        return result;
      }),
      VALIDATE_INTERVAL: z
        .string()
        .optional()
        .transform((value, ctx) => {
          // It is a range
          if (value?.includes("-")) {
            const [start, end] = value.split("-");
            const [rangeStart, rangeEnd] = [
              parseTime(start, ctx),
              parseTime(end, ctx),
            ];

            if (rangeStart === z.NEVER || rangeEnd === z.NEVER) {
              return z.NEVER;
            }

            if (isMainThread) {
              console.log(
                blue.bold(
                  `[INFO] Validation interval is enabled for between: ${readableTime(
                    rangeStart
                  )}-${readableTime(rangeEnd)}`
                )
              );
            }

            return {
              start: rangeStart,
              end: rangeEnd,
            };
          }

          if (value !== undefined) {
            const result = parseTime(value, ctx);

            if (result === z.NEVER) {
              return z.NEVER;
            }

            if (isMainThread) {
              console.log(
                blue.bold(
                  `[INFO] Validation interval is enabled for: ${readableTime(
                    result
                  )}`
                )
              );
            }
            return result;
          }

          return undefined;
        }),
      CLOSE_AGREEMENTS_AT_STARTUP: z
        .string()
        .default("false")
        .transform((value) => value === "true"),
      CLOSE_EPOCH: z
        .string()
        .default("true")
        .transform((value) => value === "true"),
      EMIT_REWARDS: z
        .string()
        .default("false")
        .transform((value) => value === "true"),
      GRACEFUL_SHUTDOWN: z
        .string()
        .default("true")
        .transform((value) => value === "true"),
      MAX_VALIDATION_TO_COMMIT: z.coerce.number().default(10),
      RPC_RATE_LIMIT: z.coerce.number().default(20),
      REGISTRY_ADDRESS: addressSchema.optional(),
      SLASHER_ADDRESS: addressSchema.optional(),
      TOKEN_ADDRESS: addressSchema.optional(),
      USDC_ADDRESS: addressSchema.optional(),
    })
    .superRefine((value, ctx) => {
      if (
        value.LISTEN_BLOCKCHAIN === false &&
        value.VALIDATE_INTERVAL === undefined
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Either "LISTEN_BLOCKCHAIN" or "VALIDATE_INTERVAL" must be set`,
        });

        return z.NEVER;
      }

      return value;
    });
  const validation = environmentSchema.safeParse(process.env, {});

  if (validation.error) {
    const error = validation.error.errors[0];
    const path = error.path.length > 0 ? error.path.join(".") + ": " : "";
    console.error(
      red(`Error while parsing environment variables: ${path}${error.message}`)
    );
    process.exit(1);
  }

  return {
    ...validation.data,
    REGISTRY_ADDRESS:
      validation.data.REGISTRY_ADDRESS ||
      getContractAddressByChain(validation.data.CHAIN, ForestRegistryAddress),
    SLASHER_ADDRESS:
      validation.data.SLASHER_ADDRESS ||
      getContractAddressByChain(validation.data.CHAIN, ForestSlasherAddress),
    TOKEN_ADDRESS:
      validation.data.TOKEN_ADDRESS ||
      getContractAddressByChain(validation.data.CHAIN, ForestTokenAddress),
    USDC_ADDRESS:
      validation.data.USDC_ADDRESS ||
      getContractAddressByChain(validation.data.CHAIN, USDCAddress),
    validatorConfigurations: parseValidatorConfigurations(),
  };
}

// Parse variables
const env = parseEnvVariables();

setGlobalRateLimit(env.RPC_RATE_LIMIT);

export const config = {
  ...env,

  // This must be initialized but since it Validator creation is an
  // async process, it should be done somewhere else (check index.ts)
  validators: {} as Record<string, Validator>,
};
