/**
 * Evaluation Adapter Interface & Contracts (Phase C)
 *
 * Pluggable abstraction for executing benchmark cases against diverse target models
 * and runtimes (DemoApp, OpenAI-compatible APIs, Custom REST endpoints).
 */

export interface BenchmarkCase {
  id: string;
  category: 'qa' | 'summarize' | 'extract' | 'tool';
  input: string;
  assertions: {
    contains_any?: string[];
    contains_all?: string[];
    max_latency_ms?: number;
    structured_schema?: Record<string, unknown>;
    expected_tool?: string;
    validate_tool_schema?: string;
    required_args?: Record<string, unknown>;
  };
}

export interface AdapterExecutionResult {
  ok: boolean;
  status: number;
  response_text?: string;
  tool_calls?: Array<{ name: string; arguments: Record<string, unknown> }>;
  structured_data?: Record<string, unknown>;
  usage_cost?: number;
  latency_ms: number;
  error?: string;
}

export interface EvaluationAdapter {
  readonly name: string;
  executeCase(bCase: BenchmarkCase): Promise<AdapterExecutionResult>;
}
