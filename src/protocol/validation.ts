import { TestResult } from "@/core/types";
import { BaseValidation } from "@/base/BaseValidation";
import { AbstractTestConstructor } from "@/base/AbstractTest";
import { Prompt, PromptSet, PromptSetSchema } from "./types";
import { config } from "@/core/config";
import axios from "axios";
import { PeerBenchUploader } from "@/uploaders/PeerBench";
import { PromptTest } from "./tests/PromptTest";

/**
 * Define the general necessary actions for your tests.
 */
export class Validation extends BaseValidation {
  override parameters = {
    /** Default value for parameters of the Validation process */
  };
  override readonly tests: AbstractTestConstructor[] = [];

  promptSet!: PromptSet;
  prompts: Prompt[] = [];

  override async onStart() {
    await this.initializePrompts();

    // Add PromptTest for each prompt
    for (let i = 0; i < this.prompts.length; i++) {
      this.tests.push(PromptTest);
    }
  }

  override async calculateScore(testResults: TestResult[]): Promise<number> {
    // Sum up the number of successful tests
    return testResults.reduce(
      (acc, testResult) => acc + (testResult.isSuccess ? 1 : 0),
      0
    );
  }

  /**
   * Fetch the prompts from PeerBench server
   */
  async initializePrompts() {
    // Get token from PeerBench uploader since it already has it
    const validator = config.validators[this.validatorTag];
    let uploader: PeerBenchUploader | undefined;

    for (const valUploader of validator.uploaders) {
      if (valUploader instanceof PeerBenchUploader) {
        uploader = valUploader;
      }
    }

    if (!uploader) {
      throw new Error(
        "Validation uses the token from PeerBenchUploader class. In order to fetch prompts from the server, please enable that uploader via the env variable"
      );
    }

    if (!uploader.token) {
      throw new Error(
        "PeerBenchUploader class has no token. Please check if PeerBenchUploader class is working properly"
      );
    }

    await this.fetchPromptSet(uploader.token);
    await this.fetchPrompts(uploader.token);
  }

  /**
   * Fetch the prompt set from PeerBench server
   */
  async fetchPromptSet(token: string) {
    this.logger.info(`Fetching MedQA prompt set from the server.`);
    const response = await axios.get(
      `${config.PEERBENCH_API_URL}/prompt-sets/1`, // MedQA prompt set id
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );
    this.promptSet = PromptSetSchema.parse(response.data);
  }

  /**
   * Fetch prompts for the chosen prompt set
   */
  async fetchPrompts(token: string) {
    this.logger.info(
      `Fetching prompts for prompt set "${this.promptSet.title}" (id: ${this.promptSet.id})`
    );

    const pageSize = config.PROMPT_PER_VALIDATION;
    const totalPages = Math.ceil(this.promptSet.questionCount / pageSize);
    const page = Math.floor(Math.random() * totalPages);

    this.logger.debug(
      `page: ${page}, totalPages: ${totalPages}, pageSize: ${pageSize}, promptSet.questionCount: ${this.promptSet.questionCount}`
    );

    const response = await axios.get(`${config.PEERBENCH_API_URL}/prompts`, {
      params: {
        promptSetId: this.promptSet.id,
        page,
        pageSize,
      },
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    this.prompts = response.data;
  }
}
