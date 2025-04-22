import { TerminationError } from "@forest-protocols/sdk";
import { abortController } from "./signal";

export class PromiseQueue {
  private concurrency: number;
  private promises: (() => Promise<any>)[] = [];
  private activePromises = 0;

  constructor(options?: { concurrency?: number }) {
    if (options?.concurrency === 0) {
      this.concurrency = 0;
    } else {
      this.concurrency = options?.concurrency || 1;
    }
  }

  async queue<T = unknown>(
    fn: () => Promise<T>,
    ignoreTermination?: boolean
  ): Promise<T> {
    if (ignoreTermination !== true && abortController.signal.aborted) {
      return Promise.reject(new TerminationError());
    }

    return new Promise<T>((resolve, reject) => {
      const task = () => {
        this.activePromises++;
        return fn()
          .then(resolve)
          .catch(reject)
          .finally(() => {
            this.activePromises--;
            this.drain(); // Trigger draining the queue
          });
      };

      // Add new promise to the queue and trigger draining the queue
      this.promises.push(task);
      this.drain();
    });
  }

  private async drain() {
    while (
      this.promises.length > 0 &&
      // If the concurrency is enabled, check if there is enough slot for the next execution.
      (this.concurrency === 0 || this.activePromises < this.concurrency)
    ) {
      const next = this.promises.shift();
      next?.();
    }
  }
}
