import {
  AbstractPipe,
  PipeResponse,
  PipeSendRequest,
  TimeoutError,
} from "@forest-protocols/sdk";
import { v7 as uuidv7 } from "uuid";
import { parentPort } from "worker_threads";
import { ThreadMessage, ThreadMessageObject } from "./types";

/**
 * Pipe implementation that uses the actual Pipe from the main
 * thread rather than creating its own.
 */
export class ThreadPipe extends AbstractPipe {
  async init() {}

  async send(to: string, req: PipeSendRequest): Promise<PipeResponse> {
    const requestId = uuidv7();

    return new Promise((res, rej) => {
      const timeout = setTimeout(() => {
        rej(new TimeoutError("Pipe request to the main thread"));
      }, req.timeout || 30_000);
      const clear = () => {
        parentPort?.off("message", messageHandler);
        clearTimeout(timeout);
      };

      const messageHandler = (message: ThreadMessageObject) => {
        if (message.data?.id === requestId) {
          if (message.type === ThreadMessage.PipeError) {
            clear();
            return rej(message.data.error);
          }

          if (message.type === ThreadMessage.PipeResponse) {
            clear();
            return res(message.data.response);
          }
        }
      };
      parentPort?.on("message", messageHandler);

      parentPort?.postMessage({
        type: ThreadMessage.PipeSend,
        data: {
          id: requestId,
          to,
          request: req,
        },
      });
    });
  }

  async close() {
    return Promise.resolve();
  }

  async route() {
    throw new Error("Method not implemented.");
  }
}
