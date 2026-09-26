import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export function getConfig() {
    try {
        const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'config.ts');
        const content = readFileSync(file, 'utf8');
        const modelMatch = content.match(/active_model:\s*process\.env\.APP_MODEL\s*\?\?\s*['"]([^'"]+)['"]/);
        const modeMatch = content.match(/routing_mode:\s*\(process\.env\.APP_ROUTING_MODE\s*as\s*[^)]+\)\s*\?\?\s*['"]([^'"]+)['"]/);
        return {
            active_model: process.env.APP_MODEL ?? modelMatch?.[1] ?? 'model-a',
            routing_mode: process.env.APP_ROUTING_MODE ?? modeMatch?.[1] ?? 'direct',
            port: Number(process.env.PORT ?? 8955),
        };
    }
    catch {
        return {
            active_model: process.env.APP_MODEL ?? 'model-a',
            routing_mode: process.env.APP_ROUTING_MODE ?? 'direct',
            port: Number(process.env.PORT ?? 8955),
        };
    }
}
export const config = {
    active_model: process.env.APP_MODEL ?? 'model-a',
    routing_mode: process.env.APP_ROUTING_MODE ?? 'direct',
    port: Number(process.env.PORT ?? 8955),
};
export const MODEL_METRICS = {
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
