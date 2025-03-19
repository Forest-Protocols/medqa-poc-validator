import { MaybePromise } from "@/core/types";

/**
 * Divides the given array into chunks which has the given length.
 * Calls `callback` for each chunk. If the callback is async, all chunks
 * will be executed sequentially.
 */
export async function chunked<T>(
  chunkLength: number,
  array: T[],
  callback: (chunk: T[]) => MaybePromise<void>
): Promise<void> {
  for (let i = 0; i < array.length; i += chunkLength) {
    const chunk = array.slice(i, i + chunkLength);
    await callback(chunk);
  }
}
