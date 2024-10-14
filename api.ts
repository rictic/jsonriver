import OpenAI from 'openai';

const openai = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey:
    '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',
  defaultHeaders: {
    'HTTP-Referer': 'https://github.com/rictic/jsonriver',
    'X-Title': 'jsonriver examples',
  },
});

async function main() {
  const completion = await openai.chat.completions.create({
    stream: true,
    model: 'openai/gpt-4o',
    messages: [
      {
        role: 'user',
        content:
          'Please call the get_latest_population_count function to get the population of the top ten countries by gdp.',
      },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'get_latest_population_count',
          parameters: {
            type: 'object',
            properties: {
              polities: {
                type: 'array',
                items: {
                  type: 'string',
                },
              },
            },
            required: ['name'],
            additionalProperties: false,
          },
        },
      },
    ],
  });

  for await (const chunk of completion) {
    for (const choice of chunk.choices) {
      console.log(choice);
      choice.delta.tool_calls?.[0].function
      // console.log(choice.delta);
      // for (const call of choice.delta.tool_calls ?? []) {
      //   console.log(call);
      // }
    }
  }

  // console.log(completion.choices[0].message);
}

await main();
