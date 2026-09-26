import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';

// Primary model for complex tasks
const PRIMARY_MODEL = 'gpt-4o';
// Fallback model for simple tasks
const FALLBACK_MODEL = 'claude-3-haiku';

const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export const ANALYSIS_TOOLS = [
  {
    name: 'analyze_sentiment',
    description: 'Analyze sentiment of customer feedback',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to analyze' },
        language: { type: 'string', enum: ['en', 'es', 'fr', 'de'] },
      },
      required: ['text'],
    },
  },
  {
    name: 'extract_entities',
    description: 'Extract named entities from text',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to process' },
        entity_types: { type: 'array', items: { type: 'string' }, description: 'Entity types to extract' },
      },
      required: ['text'],
    },
  },
  {
    name: 'classify_intent',
    description: 'Classify user intent from message',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'User message' },
        context: { type: 'string', description: 'Conversation context' },
      },
      required: ['message'],
    },
  },
];

const systemPrompt = `You are an advanced text analysis assistant.
You support sentiment analysis, entity extraction, and intent classification.
Always use the appropriate tool for the user's request.`;

export async function processWithPrimary(input: string) {
  return openaiClient.chat.completions.create({
    model: PRIMARY_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: input },
    ],
    tools: ANALYSIS_TOOLS.map(t => ({ type: 'function' as const, function: t })),
  });
}

export async function processWithFallback(input: string) {
  return anthropicClient.messages.create({
    model: FALLBACK_MODEL,
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: 'user', content: input }],
  });
}
