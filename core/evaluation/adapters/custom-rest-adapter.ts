/**
 * Custom REST Adapter (Phase C)
 *
 * Implements evaluation execution against arbitrary enterprise REST APIs
 * using template interpolation and configurable response field mappings.
 */

import type { EvaluationAdapter, BenchmarkCase, AdapterExecutionResult } from '../evaluation-adapter.js';
import type { EvaluationAdapterConfig } from '../../types.js';

export class CustomRestAdapter implements EvaluationAdapter {
  readonly name = 'CustomRestAdapter';
  private config: EvaluationAdapterConfig;
  private endpointUrl: string;

  constructor(config: EvaluationAdapterConfig) {
    if (!config.endpoint_url) {
      throw new Error('CustomRestAdapter requires endpoint_url in config');
    }
    this.config = config;
    this.endpointUrl = config.endpoint_url;
  }

  async executeCase(bCase: BenchmarkCase): Promise<AdapterExecutionResult> {
    const start = performance.now();
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(this.config.headers ?? {}),
      };

      // Construct request body using template or defaults
      let body: any;
      if (this.config.request_template) {
        const serialized = JSON.stringify(this.config.request_template);
        const replaced = serialized
          .replace(/\{\{input\}\}/g, bCase.input)
          .replace(/\{\{category\}\}/g, bCase.category);
        body = JSON.parse(replaced);
      } else {
        body = {
          prompt: bCase.input,
          task: bCase.category,
        };
      }

      const resp = await fetch(this.endpointUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      const elapsed = Math.round(performance.now() - start);

      if (!resp.ok) {
        return {
          ok: false,
          status: resp.status,
          latency_ms: elapsed,
          error: `HTTP ${resp.status}: ${await resp.text()}`,
        };
      }

      const data = await resp.json() as any;
      const mapping = this.config.response_mapping ?? {};

      const responseText = mapping.response_field
        ? getNestedProperty(data, mapping.response_field)
        : (data.response ?? data.text ?? data.content ?? '');

      const toolCalls = mapping.tool_calls_field
        ? getNestedProperty(data, mapping.tool_calls_field)
        : (data.tool_calls ?? []);

      const structuredData = mapping.structured_data_field
        ? getNestedProperty(data, mapping.structured_data_field)
        : (data.structured_data ?? {});

      const usageCost = mapping.usage_cost_field
        ? Number(getNestedProperty(data, mapping.usage_cost_field) ?? 0.0001)
        : (data.usage?.cost ?? 0.0001);

      return {
        ok: true,
        status: resp.status,
        response_text: String(responseText ?? ''),
        tool_calls: Array.isArray(toolCalls) ? toolCalls : [],
        structured_data: typeof structuredData === 'object' && structuredData !== null ? structuredData : {},
        usage_cost: usageCost,
        latency_ms: elapsed,
      };
    } catch (err) {
      const elapsed = Math.round(performance.now() - start);
      return {
        ok: false,
        status: 0,
        latency_ms: elapsed,
        error: `CustomRestAdapter error: ${(err as Error).message}`,
      };
    }
  }
}

function getNestedProperty(obj: any, pathStr: string): any {
  if (!obj || !pathStr) return undefined;
  const parts = pathStr.split('.');
  let curr = obj;
  for (const part of parts) {
    if (curr === undefined || curr === null) return undefined;
    curr = curr[part];
  }
  return curr;
}
