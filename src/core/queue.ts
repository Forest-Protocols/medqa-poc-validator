import { TerminationError } from "@forest-protocols/sdk";
import { abortController } from "./signal";

export class PromiseQueue {
  private currentPromise = Promise.resolve();
  private queue: (() => Promise<any>)[] = [];

  async add<T = unknown>(
    fn: () => Promise<T>,
    ignoreTermination?: boolean
  ): Promise<T> {
    if (ignoreTermination !== true && abortController.signal.aborted) {
      return Promise.reject(new TerminationError());
    }

    return new Promise<T>((resolve, reject) => {
      const task = async () => {
        try {
          return resolve(await fn());
        } catch (error) {
          reject(error);
        }
      };

      this.queue.push(task);

      // Chain the next execution onto the existing promise chain
      this.currentPromise = this.currentPromise.then(() => {
        if (this.queue.length > 0) {
          const nextTask = this.queue.shift();
          return nextTask?.();
        }
      });
    });
  }
}
