/**
 * @license
 * Copyright Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */
// @ts-check

import {parse} from './jsonriver.js';

function decode(encoded) {
  const sillyKey = /** @type {string} */ (import.meta.url.split('/').at(-1));
  let decoded = '';
  for (let i = 0; i < encoded.length; i++) {
    decoded += String.fromCharCode(
      encoded.charCodeAt(i) ^ sillyKey.charCodeAt(i % sillyKey.length),
    );
  }
  return decoded;
}

const completed = new WeakMap();
function markCompleted(value) {
  if (value && typeof value === 'object') {
    completed.set(value, true);
  }
}
export function isComplete(value) {
  if (value && typeof value === 'object') {
    return completed.has(value);
  }
}

export async function* makeLlmRequest(request, abortSignal = undefined) {
  // If you're reading this, you're definitely smart enough to figure out
  // how to decode this, it's just enough to defeat very simple bots.
  // The key's only got a few bucks in it, enough for anyone who wants to
  // play a bit with using jsonriver to parse JSON.
  // I trust you not to be a jerk :)
  const h = new Headers();
  h.set('Content-Type', 'application/json');
  h.set('HTTP-Referer', 'https://github.com/rictic/jsonriver');
  h.set('X-Title', `jsonriver examples`);
  h.set(
    decode('-\u0019\u0019F\u0005\u0001\u0005\u0016\fZ\u0003\u001c\u0002'),
    decode(
      '.\t\f\\\u000f\u0001L\u001f\u0006\u0003\u0005\u0001A\u001a\\\u0003[KXZU\u0019SG[[\t\u0019\b\u0010\u000f\bTHY@_[^\u0017\\D\r^[\u001c\bA\t\u000f\u000e\u001d]FTT_\u001f^\u0015\t\r\u000eLX\u0015T\t\t\u001b\\\u0010\u000e\bX\u0016YEXU',
    ),
  );

  const response = await fetch(
    decode(
      '\u0004\u0018\u0019^\u0019ICC\u0002^\u000f\u001d\u001e\u0003\u0018Z\u000f\u0001B\r\u0004\u0001\u000b\u0003\u0005C\u001b\u001fE\u0010\u0004\r\u0019\u0001\t\u001c\u0001\u001c\u0001K\u001e\u001a\u0003\u0002\u001e',
    ),
    {
      method: 'POST',
      signal: abortSignal,
      headers: h,
      body: JSON.stringify({
        model: 'google/gemma-3-27b-it',
        stream: true,
        messages: [
          {
            role: 'system',
            content: `Generate a JSON array with objects with short 'heading' and a 'body'. For example:

User: Please list your favorite three grandmas from television.
Assistant: [
  {
    "heading": "Sophia Petrillo (\"The Golden Girls\")",
    "body": "Sophia was the oldest resident of the Miami household, mother to Dorothy Zbornak. Despite her small stature and advanced age, Sophia was known for her razor-sharp wit and sarcastic comebacks. She often began stories with \"Picture it: Sicily, 1922...\" which would lead to outrageous tales from her past. Estelle Getty's portrayal of Sophia was so popular that the character appeared not only in all seven seasons of \"The Golden Girls\" but also in the spin-off series \"The Golden Palace\" and made guest appearances on \"Empty Nest\" and \"Nurses.\""
  },
  {
    "heading": "Marie Barone (\"Everybody Loves Raymond\")",
    "body": "Marie was the quintessential overbearing Italian-American mother and grandmother. She lived across the street from her son Raymond and his family, constantly interfering in their lives under the guise of helping. Marie was an excellent cook who used food as a way to show love and exert control. Her passive-aggressive relationship with her daughter-in-law Debra was a major source of comedy in the show. Despite her sometimes maddening behavior, Marie's actions were always rooted in love for her family. Doris Roberts won four Emmy Awards for her portrayal of Marie."
  },
  {
    "heading": "Grandma Mazur (\"One for the Money\")",
    "body": "Grandma Mazur is a character from Janet Evanovich's Stephanie Plum novel series, who appeared in the film adaptation \"One for the Money.\" In her 70s, Grandma Mazur is anything but a typical grandmother. She's fond of attending funeral viewings for entertainment, carries a .45 caliber handgun in her purse, and often provides comic relief with her inappropriate comments and actions. In the books, she lives with Stephanie's parents and often drives her son-in-law to distraction. While the film wasn't as successful as fans hoped, Debbie Reynolds' portrayal captured Grandma Mazur's spirited and unconventional nature."
  }
]

No matter what kind of question the user asks, always return a JSON array, with objects that have a 'heading' and a 'body'. It's ok to be silly, or strange, and to really stretch what the user is asking for in order to turn it into a list. This is just for a simple demo site, so the output doesn't matter too much. Have fun!

Only return the JSON! No wrappers, no prose, no markdown around it, just the JSON!
`,
          },
          {
            role: 'user',
            content: request,
          },
        ],
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`Failed to make request: ${response.status}`);
  }
  // The response comes down as SSE events that each have a JSON payload which
  // itself contains a bit of text generated by the model which we then
  // want to pass to jsonriver to parse!
  yield* parse(stripWrappers(getLlmOutput(response)), {
    completeCallback: markCompleted,
  });
}

async function* stripWrappers(stream) {
  // Some models wrap their output in a ```json\n...\n``` block, which we want
  // to strip off.
  let buffer = '';
  while (true) {
    const chunk = await stream.next();
    if (chunk.done) {
      break;
    }
    buffer += chunk.value;
    if (buffer.startsWith('```json')) {
      buffer = buffer.slice('```json\n'.length);
      break;
    } else if (buffer.length > 20) {
      break;
    }
  }
  // Now we just pass through the rest of the stream, but delayed by
  // eight characters so that when we're finished we can strip off the
  // trailing ```
  while (true) {
    const chunk = await stream.next();
    if (chunk.done) {
      break;
    }
    buffer += chunk.value;
    if (buffer.length > 8) {
      yield buffer.slice(0, -8);
      buffer = buffer.slice(-8);
    }
  }
  const match = buffer.match(/```\s+$/m);
  if (match) {
    yield buffer.slice(0, match.index);
  } else {
    yield buffer;
  }
}

/**
 * @param {Response} response
 * @returns {AsyncGenerator<string>}
 */
async function* getLlmOutput(response) {
  packets: for await (const event of packetizeSSE(response)) {
    const parsed = parseServerSentEvent(event);
    for (const part of parsed.parts) {
      if (part.type === 'field' && part.name === 'data') {
        if (part.value === '[DONE]') {
          break packets;
        }
        let parsed;
        try {
          parsed = /** @type {StreamedResponse} */ (JSON.parse(part.value));
        } catch {
          console.error(part);
          throw new Error(
            `Failed to parse JSON from LLM API, full event; ${JSON.stringify(
              event,
            )}`,
          );
        }
        if (parsed.choices.length === 0) {
          continue;
        }
        if (parsed.choices.length > 1) {
          console.error(part);
          throw new Error(
            `Can't handle multiple choices from streamed model response`,
          );
        }
        if (parsed.choices[0].delta.role !== 'assistant') {
          console.error(part);
          throw new Error(
            `Expected assistant response, got ${parsed.choices[0].delta.role}`,
          );
        }
        // console.log(parsed.choices);
        yield parsed.choices[0].delta.content;
      }
    }
  }
}

/**
 * Breaks a stream of bytes up into a stream of textual
 * Server Sent Event (SSE) messages.
 *
 * @param {Response} response
 * @returns {AsyncIterableIterator<string>}
 */
async function* packetizeSSE(response) {
  let buffer = '';
  const body = response.body;
  if (!body) {
    return;
  }
  for await (const chunk of body.pipeThrough(new TextDecoderStream())) {
    buffer += chunk;
    let match;
    while ((match = buffer.match(/((\r\n|\n|\r){2})/))) {
      const index = match.index;
      if (index === undefined) {
        continue;
      }
      const message = buffer.slice(0, index);
      buffer = buffer.slice(index + match[1].length);
      yield message;
    }
  }
  if (buffer !== '') {
    yield buffer;
  }
}

/**
 * @param {string} event
 * @returns ServerSentEvent
 */
function parseServerSentEvent(event) {
  const events = [];
  for (const line of event.split(/\r\n|\n|\r/)) {
    if (line.startsWith(':')) {
      events.push({type: 'comment', name: undefined, value: line.slice(1)});
    } else {
      const firstColon = line.indexOf(':');
      const name = line.slice(0, firstColon);
      const value = line.slice(firstColon + 2);
      events.push({type: 'field', name, value});
    }
  }
  return {parts: events};
}

/**
 * @typedef {Object} StreamedResponse
 * @property {string} id
 * @property {string} provider
 * @property {string} model
 * @property {string} [object]
 * @property {number} [created]
 * @property {Array<{
 *   index: number,
 *   delta: { role: 'assistant' | string, content: string },
 *   finish_reason?: null,
 *   logprobs?: null
 * }>} choices
 * @property {string | null} [system_fingerprint]
 */

/**
 * @typedef {Object} SSEComment
 * @property {"comment"} type
 * @property {undefined} name
 * @property {string} value
 */

/**
 * @typedef {Object} SSEField
 * @property {"field"} type
 * @property {string} name
 * @property {string} value
 */

/**
 * @typedef {Object} ServerSentEvent
 * @property {(SSEComment | SSEField)[]} parts
 */
