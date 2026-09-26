import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type ProviderType = 'groq' | 'nvidia' | 'mistral' | 'openai' | 'mock';

export interface AppConfig {
  active_model: string;
  routing_mode: 'direct' | 'hybrid';
  port: number;
  provider: ProviderType;
  apiKey?: string;
  apiBaseUrl?: string;
}

export function detectProvider(): { provider: ProviderType; apiKey?: string; apiBaseUrl?: string } {
  if (process.env.MODELFORGE_PROVIDER === 'mock') {
    return { provider: 'mock' };
  }
  if (process.env.GROQ_API_KEY) {
    return { provider: 'groq', apiKey: process.env.GROQ_API_KEY, apiBaseUrl: 'https://api.groq.com/openai/v1' };
  }
  if (process.env.NVIDIA_API_KEY) {
    return { provider: 'nvidia', apiKey: process.env.NVIDIA_API_KEY, apiBaseUrl: 'https://integrate.api.nvidia.com/v1' };
  }
  if (process.env.MISTRAL_API_KEY) {
    return { provider: 'mistral', apiKey: process.env.MISTRAL_API_KEY, apiBaseUrl: 'https://api.mistral.ai/v1' };
  }
  if (process.env.OPENAI_API_KEY) {
    return { provider: 'openai', apiKey: process.env.OPENAI_API_KEY, apiBaseUrl: 'https://api.openai.com/v1' };
  }
  return { provider: 'mock' };
}

export const PROVIDER_MODELS: Record<ProviderType, { 'model-a': string; 'model-b': string }> = {
  groq: {
    'model-a': 'llama-3.3-70b-versatile',
    'model-b': 'llama-3.1-8b-instant',
  },
  nvidia: {
    'model-a': 'meta/llama-3.3-70b-instruct',
    'model-b': 'meta/llama-3.1-8b-instruct',
  },
  mistral: {
    'model-a': 'mistral-large-latest',
    'model-b': 'mistral-small-latest',
  },
  openai: {
    'model-a': 'gpt-4o',
    'model-b': 'gpt-4o-mini',
  },
  mock: {
    'model-a': 'model-a',
    'model-b': 'model-b',
  },
};

export function getConfig(): AppConfig {
  const providerInfo = detectProvider();
  try {
    const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'config.ts');
    const content = readFileSync(file, 'utf8');
    const modelMatch = content.match(/active_model:\s*process\.env\.APP_MODEL\s*\?\?\s*['"]([^'"]+)['"]/);
    const modeMatch = content.match(/routing_mode:\s*\(process\.env\.APP_ROUTING_MODE\s*as\s*[^)]+\)\s*\?\?\s*['"]([^'"]+)['"]/);
    return {
      active_model: process.env.APP_MODEL ?? modelMatch?.[1] ?? 'model-a',
      routing_mode: (process.env.APP_ROUTING_MODE as 'direct' | 'hybrid') ?? (modeMatch?.[1] as 'direct' | 'hybrid') ?? 'direct',
      port: Number(process.env.PORT ?? 8955),
      ...providerInfo,
    };
  } catch {
    return {
      active_model: process.env.APP_MODEL ?? 'model-a',
      routing_mode: (process.env.APP_ROUTING_MODE as 'direct' | 'hybrid') ?? 'direct',
      port: Number(process.env.PORT ?? 8955),
      ...providerInfo,
    };
  }
}

export const config: AppConfig = {
  active_model: process.env.APP_MODEL ?? 'model-a',
  routing_mode: (process.env.APP_ROUTING_MODE as 'direct' | 'hybrid') ?? 'direct',
  port: Number(process.env.PORT ?? 8955),
  ...detectProvider(),
};

export const MODEL_METRICS: Record<string, { cost_per_1k_input: number; cost_per_1k_output: number; baseline_latency_ms: number }> = {
  'model-a': {
    cost_per_1k_input: 0.003,
    cost_per_1k_output: 0.015,
    baseline_latency_ms: 780,
  },
  'model-b': {
    cost_per_1k_input: 0.00015,
    cost_per_1k_output: 0.0006,
    baseline_latency_ms: 290,
  },
};
