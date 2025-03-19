import { randomInteger } from "@/utils/random-integer";
import { Validation } from "../validation";
import { HumanEvaluationTest } from "@/base/HumanEvaluationTest";
import { sleep } from "@/utils/sleep";
import { parseTime } from "@/utils/parse-time";

export type ExampleHumanEvaluationOutput = {
  sourceLanguage: string;
  targetLanguage: string;
  sourceText: string;
  translatedText: string;
};

export class ExampleHumanEvaluation extends HumanEvaluationTest<
  ExampleHumanEvaluationOutput,
  Validation
> {
  protected override readonly waitEvaluationsFor = parseTime("1m");

  async getOutputs(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    validation: Validation
  ): Promise<ExampleHumanEvaluationOutput[]> {
    /**
     * Implement the actual logic that retrieves
     * the outputs from the resource for specific prompts.
     *
     * Example dummy logic for translation evaluation:
     */

    const sourceEN = [
      "We live in a big house.",
      "He is my friend.",
      "I have a cat.",
    ];
    const targetSP = [
      "Tengo un gato.",
      "Ella es mi amiga",
      "We live in a big house.",
    ];

    // Simulate a process that take some time
    await sleep(3000);

    return Array<ExampleHumanEvaluationOutput>(5).fill({
      sourceLanguage: "english",
      targetLanguage: "spanish",
      sourceText: sourceEN[randomInteger(0, sourceEN.length)],
      translatedText: targetSP[randomInteger(0, targetSP.length)],
    });
  }
}
