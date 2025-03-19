import { InvalidValueError } from "@/errors/InvalidValueError";
import { z } from "zod";

/**
 * Parses a human readable time definition such as `1m`, `3h` or `30s` into milliseconds.
 * If `ctx` is given, returns a proper Zod error that can be used in `refinement()`
 */
export function parseTime(value: string, ctx?: z.RefinementCtx) {
  const units = ["h", "m", "s"]; // hours, minutes, seconds
  const multipliers = [60 * 60 * 1000, 60 * 1000];
  const unit = value[value.length - 1];
  const multiplier = multipliers[units.indexOf(unit)] || 1000; // use "seconds" multiplier by default

  if (!units.includes(unit) && unit !== "") {
    if (ctx !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Invalid time unit: "${unit}". Must be one of 'h' (hours), 'm' (minutes), 's' (seconds)`,
      });
      return z.NEVER;
    } else {
      throw new InvalidValueError(unit);
    }
  }

  const numericPart = value.substring(0, value.length - 1);
  const amount = parseInt(numericPart);

  if (!/^\d+$/.test(numericPart) || isNaN(amount)) {
    if (ctx !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Invalid number`,
      });
      return z.NEVER;
    } else {
      throw new InvalidValueError(numericPart);
    }
  }

  return amount * multiplier;
}
