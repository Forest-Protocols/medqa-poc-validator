import { HTTPPipe } from "@forest-protocols/sdk";

/**
 * Operator pipes in this daemon
 */
export const pipes: {
  [operatorAddr: string]: HTTPPipe;
} = {};
