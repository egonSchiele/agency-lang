
import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Define the schema for structured output
const NumberSchema = z.object({
  value: z.number(),
});

async function getStructuredNumber() {
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-2024-08-06", // Structured outputs require this model or later
    messages: [
      {
        role: "user",
        content: "the number 1,",
      },
    ],
    response_format: zodResponseFormat(NumberSchema, "number_response"),
  });

  const result = completion.choices[0].message.parsed;
  console.log(result); // { value: 1 }
  console.log(result?.value); // 1

  return result;
}

getStructuredNumber();
