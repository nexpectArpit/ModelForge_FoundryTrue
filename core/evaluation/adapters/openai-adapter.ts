/**
 * OpenAI-Compatible Adapter (Phase C)
 *
 * Implements evaluation execution against OpenAI-compatible /v1/chat/completions
 * endpoints (OpenAI, Groq, NVIDIA NIM, TrueFoundry Gateway, vLLM, Ollama).
 */

import type { EvaluationAdapter, BenchmarkCase, AdapterExecutionResult } from '../evaluation-adapter.js';

export interface OpenAICompatibleAdapterOptions {
  baseUrl: string;
  apiKey?: string;
  model: string;
  timeoutMs?: number;
  customHeaders?: Record<string, string>;
}

export class OpenAICompatibleAdapter implements EvaluationAdapter {
  readonly name = 'OpenAICompatibleAdapter';
  private endpointUrl: string;
  private apiKey?: string;
  private model: string;
  private timeoutMs: number;
  private customHeaders: Record<string, string>;

  constructor(options: OpenAICompatibleAdapterOptions) {
    const rawBase = options.baseUrl || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
    const base = rawBase.replace(/\/+$/, '');
    this.endpointUrl = base.endsWith('/chat/completions')
      ? base
      : `${base}/chat/completions`;
    this.apiKey = options.apiKey || process.env.OPENAI_API_KEY;
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? 20000;
    this.customHeaders = options.customHeaders ?? {};
  }

  async executeCase(bCase: BenchmarkCase): Promise<AdapterExecutionResult> {
    const start = performance.now();
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...this.customHeaders,
      };
      if (this.apiKey) {
        headers['Authorization'] = `Bearer ${this.apiKey}`;
      }

      const bodyPayload: Record<string, unknown> = {
        model: this.model,
        messages: [{ role: 'user', content: bCase.input }],
        temperature: 0.0,
      };

      // If tool-calling category, provide dummy tool schema if expected_tool is defined
      if (bCase.category === 'tool' && bCase.assertions.expected_tool) {
        bodyPayload.tools = [
          {
            type: 'function',
            function: {
              name: bCase.assertions.expected_tool,
              description: 'Operational tool for customer support',
              parameters: {
                type: 'object',
                properties: {
                  order_id: { type: 'integer' },
                  user_id: { type: 'string' },
                  issue_type: { type: 'string' },
                  priority: { type: 'string' },
                  reason: { type: 'string' },
                },
              },
            },
          },
        ];
        bodyPayload.tool_choice = 'auto';
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      const resp = await fetch(this.endpointUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(bodyPayload),
        signal: controller.signal,
      });

      clearTimeout(timer);
      const elapsed = Math.round(performance.now() - start);

      if (!resp.ok) {
        const errText = await resp.text();
        return {
          ok: false,
          status: resp.status,
          latency_ms: elapsed,
          error: `HTTP ${resp.status}: ${errText}`,
        };
      }

      const data = await resp.json() as any;
      const message = data.choices?.[0]?.message;
      const responseText = message?.content ?? '';

      // Parse tool calls
      const toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
      if (message?.tool_calls && Array.isArray(message.tool_calls)) {
        for (const tc of message.tool_calls) {
          try {
            const args = typeof tc.function?.arguments === 'string'
              ? JSON.parse(tc.function.arguments)
              : (tc.function?.arguments ?? {});
            toolCalls.push({
              name: tc.function?.name ?? '',
              arguments: args,
            });
          } catch {
            toolCalls.push({
              name: tc.function?.name ?? '',
              arguments: { _raw: tc.function?.arguments },
            });
          }
        }
      }

      // Try parsing JSON structured data from content if extract category
      let structuredData: Record<string, unknown> = {};
      if (bCase.category === 'extract') {
        try {
          const jsonMatch = responseText.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            structuredData = JSON.parse(jsonMatch[0]);
          }
        } catch {
          // Keep empty if unparseable
        }
      }

      // Calculate cost from token usage if available
      const promptTokens = data.usage?.prompt_tokens ?? 0;
      const completionTokens = data.usage?.completion_tokens ?? 0;
      const estimatedCost = (promptTokens * 0.0000015) + (completionTokens * 0.000002);

      return {
        ok: true,
        status: resp.status,
        response_text: responseText,
        tool_calls: toolCalls,
        structured_data: structuredData,
        usage_cost: estimatedCost > 0 ? estimatedCost : 0.0001,
        latency_ms: elapsed,
      };
    } catch (err) {
      const elapsed = Math.round(performance.now() - start);
      return {
        ok: false,
        status: 0,
        latency_ms: elapsed,
        error: `OpenAI Adapter error: ${(err as Error).message}`,
      };
    }
  }
}
