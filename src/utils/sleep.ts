import { sleep as sdkSleep } from "@forest-protocols/sdk";
import { abortController } from "@/core/signal";

/**
 * Wrapper function for `sdk/sleep()` which uses global
 * abort controller.
 */
export async function sleep(ms: number) {
  return await sdkSleep(ms, abortController.signal);
}
