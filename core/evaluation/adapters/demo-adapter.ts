/**
 * Demo Adapter (Phase C)
 *
 * Implements evaluation execution against customer-support-app and similar
 * test microservices exporting an HTTP /api/chat endpoint.
 */

import type { EvaluationAdapter, BenchmarkCase, AdapterExecutionResult } from '../evaluation-adapter.js';

export interface DemoAdapterOptions {
  endpointUrl: string;
  timeoutMs?: number;
}

export class DemoAdapter implements EvaluationAdapter {
  readonly name = 'DemoAdapter';
  private endpointUrl: string;
  private timeoutMs: number;

  constructor(options: DemoAdapterOptions) {
    this.endpointUrl = options.endpointUrl;
    this.timeoutMs = options.timeoutMs ?? 15000;
  }

  async executeCase(bCase: BenchmarkCase): Promise<AdapterExecutionResult> {
    const start = performance.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      const resp = await fetch(this.endpointUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: bCase.input,
          task_hint: bCase.category,
        }),
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
      return {
        ok: true,
        status: resp.status,
        response_text: data.response ?? '',
        tool_calls: data.tool_calls ?? [],
        structured_data: data.structured_data ?? {},
        usage_cost: data.usage?.estimated_cost ?? 0.0001,
        latency_ms: elapsed,
      };
    } catch (err) {
      const elapsed = Math.round(performance.now() - start);
      return {
        ok: false,
        status: 0,
        latency_ms: elapsed,
        error: `Network/Fetch error: ${(err as Error).message}`,
      };
    }
  }
}
