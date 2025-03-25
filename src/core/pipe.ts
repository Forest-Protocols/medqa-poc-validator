import { XMTPv3Pipe } from "@forest-protocols/sdk";

/**
 * Operator pipes in this daemon
 */
export const pipes: {
  [operatorAddr: string]: XMTPv3Pipe;
} = {};
