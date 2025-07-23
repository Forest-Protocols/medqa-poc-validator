import winston, { createLogger, transports } from "winston";
import { config } from "./config";
import * as ansis from "ansis";
import { ensureError } from "@/utils/ensure-error";
import { isTermination } from "@/utils/is-termination";

type ColorName = "red" | "yellow" | "green" | "magenta" | "cyan";
type LogLevel = "error" | "warning" | "info" | "debug";

const colors = {
  error: "red",
  warning: "yellow",
  info: "green",
  debug: "cyan",
};

const decolorize = (str: string): string => {
  return str.replace(
    // eslint-disable-next-line no-control-regex
    /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g,
    ""
  );
};

let format;

switch (config.LOG_TYPE) {
  case "json":
    format = winston.format.combine(
      winston.format.timestamp(),
      winston.format.json({
        replacer(key, value) {
          if (key === "message") {
            // decolorize the message
            return decolorize(value as string);
          }
          return value;
        },
      })
    );
    break;
  case "pretty":
    format = winston.format.combine(
      winston.format.prettyPrint(),
      winston.format.splat(),
      winston.format.timestamp({
        format: "YYYY/MM/DD - HH:mm:ss",
      }),
      winston.format.printf((info) => {
        const color = colors[info.level as LogLevel];
        const levelColor = ansis[color as ColorName];
        const context = (info.context as string) || "";
        const meta = {
          ...info,
          context: undefined,
          level: undefined,
          timestamp: undefined,
          message: undefined,
        };
        const formatted = [
          `${info.timestamp}`,
          levelColor.bold(info.level.toUpperCase()),
          levelColor.bold(`[${context || "Main"}]`).padEnd(25),
          levelColor(
            config.NODE_ENV == "dev" && info.stack
              ? `${info.message}${(info.stack as string[]).join("\n")}`
              : info.message
          ),
          levelColor(
            Object.entries(meta)
              .filter(([, value]) => value !== undefined)
              .map(([key, value]) => `${key}=${value}`)
              .join(" ")
          ),
        ];

        return formatted.filter((f) => f).join(" ");
      })
    );
    break;
}

export const logger = createLogger({
  level: config.LOG_LEVEL,
  levels: {
    error: 0,
    warning: 1,
    info: 2,
    debug: 3,
  },
  transports: [
    new transports.Console({
      format,
    }),
  ],
});

/**
 * Logs the given err with the given logger.
 * Ensures that `err` is not a termination error.
 */
export function logError(params: {
  err: unknown;
  logger: winston.Logger;
  prefix?: string;
  meta?: Record<string, any>;
}) {
  if (isTermination(params.err)) return;

  const error = ensureError(params.err);
  params.logger.error(`${params.prefix || "Something went wrong"}`, {
    stacktrace: error.stack,
    ...(params.meta || {}),
  });
}
