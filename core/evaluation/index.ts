/**
 * Core Evaluation Module Index (Phase C)
 *
 * Canonical evaluation subsystem:
 *   - EvaluationEngine
 *   - EvaluationAdapter
 *   - DemoAdapter
 *   - OpenAICompatibleAdapter
 *   - CustomRestAdapter
 */

export * from './evaluation-adapter.js';
export * from './adapters/demo-adapter.js';
export * from './adapters/openai-adapter.js';
export * from './adapters/custom-rest-adapter.js';
export * from './evaluation-engine.js';
