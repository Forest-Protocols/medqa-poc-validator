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
      const task = () => fn().then(resolve).catch(reject);

      // Add new promise to the queue and dequeue the next item
      this.promises.push(task);
      this.dequeue();
    });
  }

  private async dequeue() {
    if (this.concurrency > 0 && this.activePromises >= this.concurrency) {
      return;
    }

    if (this.promises.length > 0) {
      const nextTask = this.promises.shift();
      return nextTask?.();
    }
  }
}
