import { z } from "zod";
import { red } from "ansis";
import {
  addressSchema,
  ForestRegistryAddress,
  ForestSlasherAddress,
  ForestTokenAddress,
  getContractAddressByChain,
  privateKeySchema,
  setGlobalRateLimit,
  setGlobalRateLimitTimeWindow,
  USDCAddress,
} from "@forest-protocols/sdk";
import { Address } from "viem";
import { Validator } from "./validator";
import { ValidatorConfiguration } from "./types";
import dotenv from "@dotenvx/dotenvx";
import { parseTime } from "@/utils/parse-time";

dotenv.config({ ignore: ["MISSING_ENV_FILE"] });
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
  const environmentSchema = z
    .object({
      LOG_TYPE: z.enum(["json", "pretty"]).default("json"),
      NODE_ENV: z.enum(["dev", "production"]).default("dev"),
      LOG_LEVEL: z.enum(["error", "warning", "info", "debug"]).default("debug"),
      DATABASE_URL: nonEmptyStringSchema,
      RPC_HOST: nonEmptyStringSchema,
      INDEXER_ENDPOINT: z.string().url().optional(),
      UPLOAD_CHECKER_INTERVAL: z
        .string()
        .default("1m")
        .transform((value, ctx) => parseTime(value, ctx)),
      CHAIN: z.enum([
        "anvil",
        "optimism",
        "optimism-sepolia",
        "base",
        "base-sepolia",
      ]),
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
      PROTOCOL_VALIDATION_EXECUTOR: z
        .string()
        .default("false")
        .transform((value) => value === "true"),
      MAX_VALIDATION_TO_COMMIT: z.coerce.number().default(10),
      RPC_RATE_LIMIT: z.coerce.number().default(20),
      RPC_RATE_LIMIT_TIME_WINDOW: z
        .string()
        .default("5s")
        .transform((value, ctx) => parseTime(value, ctx)),
      REGISTRY_ADDRESS: addressSchema.optional(),
      SLASHER_ADDRESS: addressSchema.optional(),
      TOKEN_ADDRESS: addressSchema.optional(),
      USDC_ADDRESS: addressSchema.optional(),
      ENABLED_UPLOADERS: z
        .string()
        .optional()
        .transform((value) => {
          if (!value) {
            return [];
          }

          return value.split(",").map((uploader) => uploader.trim());
        }),

      PEERBENCH_UPLOADER_SUPABASE_ANON_KEY: z
        .string()
        .default(
          "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ3bnNlcmJqanR4Z2theWRrbXRrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDU5OTczMDQsImV4cCI6MjA2MTU3MzMwNH0.hzPhuPtDYF1yMrKseoZX-P6ETpPEsGIC8mt-bieG6Kc"
        ),
      PEERBENCH_UPLOADER_SUPABASE_URL: z
        .string()
        .default("https://bwnserbjjtxgkaydkmtk.supabase.co"),
      PEERBENCH_API_URL: z.string().default("https://peerbench.ai/api"),
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
setGlobalRateLimitTimeWindow(env.RPC_RATE_LIMIT_TIME_WINDOW);

export const config = {
  ...env,

  // This must be initialized but since the "Validator creation" is an
  // async process, it should be done somewhere else (check index.ts)
  validators: {} as Record<string, Validator>,
};
