import { z } from "zod";

export const PromptSetSchema = z.object({
  id: z.number(),
  title: z.string(),
  description: z.string(),
  ownerId: z.string(),
  createdAt: z
    .union([z.string().datetime(), z.number()])
    .transform((val) => new Date(val)),
  updatedAt: z
    .union([z.string().datetime(), z.number()])
    .transform((val) => new Date(val)),
  questionCount: z.number(),
  totalAnswers: z.number(),
  firstPromptId: z.string(),
});
export type PromptSet = z.infer<typeof PromptSetSchema>;

export type Prompt = {
  id: string;
  promptSetId: number;
  fileCID: string;
  question: string;
  cid: string;
  sha256: string;
  options: Record<string, string>;
  answerKey: string;
  answer: string;
  fullPrompt: string;
  fullPromptCID: string;
  fullPromptSHA256: string;
  metadata: Record<string, any>;
};
