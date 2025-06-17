import { TestResult } from "@/core/types";
import { Validation } from "../validation";
import { PerformanceTest } from "@/base/PerformanceTest";
import { PipeMethod, PipeResponseCode } from "@forest-protocols/sdk";
import { config } from "@/core/config";
import { ChatCompletion } from "openai/resources/index";

export type PromptTestResult = {
  modelId: string;
  response: string;
  promptId: string;
};

export class PromptTest extends PerformanceTest<PromptTestResult, Validation> {
  async execute(validation: Validation): Promise<TestResult<PromptTestResult>> {
    // Pick a random prompt from the list
    const promptIndex = Math.floor(Math.random() * validation.prompts.length);
    const prompt = validation.prompts[promptIndex];

    this.logger.debug(`Executing prompt: ${JSON.stringify(prompt, null, 2)}`);

    const pipe = validation.validator.pipe;
    const response = await pipe.send(validation.resource.operatorAddress, {
      method: PipeMethod.POST,
      path: "/chat/completions",
      timeout: 15_000,
      body: {
        providerId: validation.resource.providerId,
        id: validation.resource.id,
        pt: config.PROTOCOL_ADDRESS,
        messages: [
          {
            role: "system",
            content:
              "You are an knowledge expert, you are supposed to answer the multi-choice question to derive your final answer as `The answer is ...` without any other additional text or explanation.",
          },
          {
            role: "user",
            content: prompt.fullPrompt,
          },
        ],
      },
    });

    if (response.code !== PipeResponseCode.OK) {
      throw new Error(`Request failed: ${JSON.stringify(response.body)}`);
    }

    const completion: ChatCompletion = response.body.completions;
    this.logger.debug(`Response: ${JSON.stringify(response.body, null, 2)}`);

    if (!completion) {
      throw new Error("No response received from the provider");
    }

    // TODO: Fetch the model info from the provider

    const chatResponse = completion.choices[0]!.message.content!;
    const answer = this.lookForAnswer(chatResponse, [
      {
        regex: /answer is\s+([A-Z])/gi,
        answerGroupIndex: 1,
      },
      {
        regex: /answer is\s+\**([A-Z])\**/gi,
        answerGroupIndex: 1,
      },
      {
        regex: /([A-Z]):.+/g,
        answerGroupIndex: 1,
      },
    ]);

    // Remove this prompt from the list so it won't be used again
    validation.prompts.splice(promptIndex, 1);

    return {
      isSuccess: answer !== undefined && answer === prompt.answerKey,
      raw: JSON.stringify(completion),
      result: {
        modelId: completion.model,
        response: chatResponse,
        promptId: prompt.id,
      },
      testName: this.name,
    };
  }

  lookForAnswer(
    response: string,
    patterns: {
      regex: RegExp;
      answerGroupIndex: number;
    }[]
  ) {
    for (const pattern of patterns) {
      const matches = Array.from(response.matchAll(pattern.regex));
      const match = matches.at(-1); // Use the last match

      if (match) {
        return match[pattern.answerGroupIndex];
      }
    }
  }
}
