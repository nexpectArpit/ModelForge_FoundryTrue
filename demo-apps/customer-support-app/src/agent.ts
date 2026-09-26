import { config, getConfig, MODEL_METRICS, PROVIDER_MODELS } from './config.js';
import { CreateTicketSchema, QueryRefundStatusSchema, SUPPORT_TOOLS } from './tools.js';

export interface ChatRequest {
  message: string;
  task_hint?: 'qa' | 'summarize' | 'extract' | 'tool';
}

export interface ChatResponse {
  response: string;
  model_used: string;
  task: 'qa' | 'summarize' | 'extract' | 'tool';
  tool_calls: Array<{ name: string; arguments: Record<string, unknown> }>;
  structured_data: Record<string, unknown> | null;
  latency_ms: number;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    estimated_cost: number;
  };
}

function detectTask(message: string, hint?: 'qa' | 'summarize' | 'extract' | 'tool'): 'qa' | 'summarize' | 'extract' | 'tool' {
  if (hint) return hint;
  const lower = message.toLowerCase();
  if (lower.includes('create ticket') || lower.includes('open ticket') || lower.includes('book appointment') || lower.includes('refund status')) {
    return 'tool';
  }
  if (lower.includes('extract') || lower.includes('json') || lower.includes('parse user')) {
    return 'extract';
  }
  if (lower.includes('summarize') || lower.includes('summary') || message.length > 300) {
    return 'summarize';
  }
  return 'qa';
}

async function callLiveModel({
  apiBaseUrl,
  apiKey,
  modelName,
  messages,
  tools,
}: {
  apiBaseUrl: string;
  apiKey: string;
  modelName: string;
  messages: Array<{ role: string; content: string }>;
  tools?: any[];
}) {
  const resp = await fetch(`${apiBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: modelName,
      messages,
      ...(tools && tools.length > 0 ? { tools: tools.map(t => ({ type: 'function', function: t })) } : {}),
      temperature: 0.1,
    }),
  });
  if (!resp.ok) {
    throw new Error(`LLM provider HTTP ${resp.status}: ${await resp.text()}`);
  }
  return resp.json();
}

export async function processChat(req: ChatRequest): Promise<ChatResponse> {
  const startTime = Date.now();
  const task = detectTask(req.message, req.task_hint);
  const currentConfig = getConfig();

  // Determine which model serves this task based on routing mode
  let targetModelKey: 'model-a' | 'model-b' = currentConfig.active_model === 'model-b' ? 'model-b' : 'model-a';
  if (currentConfig.routing_mode === 'hybrid') {
    // Hybrid routing strategy:
    // Tool calls stay on high-reliability model-a, bulk QA/summarize/extract go to cost-efficient model-b
    targetModelKey = task === 'tool' ? 'model-a' : 'model-b';
  }

  // Check if live API keys are provided
  if (currentConfig.apiKey && currentConfig.apiBaseUrl && currentConfig.provider !== 'mock') {
    const liveModelName = PROVIDER_MODELS[currentConfig.provider]?.[targetModelKey] ?? targetModelKey;
    try {
      const messages = [
        { role: 'system', content: 'You are a helpful customer support agent assistant.' },
        { role: 'user', content: req.message },
      ];

      const liveResult = await callLiveModel({
        apiBaseUrl: currentConfig.apiBaseUrl,
        apiKey: currentConfig.apiKey,
        modelName: liveModelName,
        messages,
        tools: task === 'tool' ? SUPPORT_TOOLS : undefined,
      });

      const choice = liveResult.choices?.[0]?.message;
      const toolCalls = (choice?.tool_calls ?? []).map((tc: any) => ({
        name: tc.function?.name ?? '',
        arguments: JSON.parse(tc.function?.arguments || '{}'),
      }));

      let structuredData: Record<string, unknown> | null = null;
      if (task === 'extract') {
        try {
          structuredData = JSON.parse(choice?.content || '{}');
        } catch {
          structuredData = null;
        }
      }

      const durationMs = Date.now() - startTime;
      const promptTokens = liveResult.usage?.prompt_tokens ?? 25;
      const completionTokens = liveResult.usage?.completion_tokens ?? 35;
      const metrics = MODEL_METRICS[targetModelKey] ?? MODEL_METRICS['model-a'];
      const cost = (promptTokens / 1000) * metrics.cost_per_1k_input + (completionTokens / 1000) * metrics.cost_per_1k_output;

      return {
        response: choice?.content ?? '',
        model_used: liveModelName,
        task,
        tool_calls: toolCalls,
        structured_data: structuredData,
        latency_ms: durationMs,
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          estimated_cost: cost,
        },
      };
    } catch (err) {
      console.warn(`[agent] Live LLM call to ${liveModelName} failed (${(err as Error).message}), falling back to deterministic simulator.`);
    }
  }

  // Deterministic high-fidelity simulator mode (runs when no API key is provided or offline)
  let responseText = '';
  let toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  let structuredData: Record<string, unknown> | null = null;
  let promptTokens = Math.max(20, Math.floor(req.message.length / 4));
  let completionTokens = 40;

  if (targetModelKey === 'model-a') {
    await new Promise(r => setTimeout(r, 60)); // Model A simulated latency
    if (task === 'qa') {
      responseText = "Our standard policy allows returns within 30 days of purchase for a full refund or store credit. Opened electronics must include all original packaging and accessories.";
      completionTokens = 35;
    } else if (task === 'summarize') {
      responseText = "Summary: Customer Jane Doe experienced double-charging on order #4812 due to a payment gateway timeout. She requested an immediate refund and priority escalation.";
      completionTokens = 45;
    } else if (task === 'extract') {
      structuredData = {
        user_id: "US-9921",
        action: "cancel_subscription",
        plan: "Pro Annual",
        sentiment: "negative"
      };
      responseText = JSON.stringify(structuredData);
      completionTokens = 30;
    } else if (task === 'tool') {
      if (req.message.toLowerCase().includes('refund')) {
        toolCalls = [{
          name: 'query_refund_status',
          arguments: { order_id: 9841, reason: "Customer requested expedited refund review" }
        }];
      } else {
        toolCalls = [{
          name: 'create_ticket',
          arguments: { order_id: 4812, user_id: "US-9921", issue_type: "billing", priority: "high" }
        }];
      }
      responseText = "I have initiated the required support action through the system tool.";
      completionTokens = 25;
    }
  } else {
    // Model B: Fast, cost-effective
    await new Promise(r => setTimeout(r, 15));
    if (task === 'qa') {
      responseText = "Our store policy allows returning opened items within 30 days with original packaging for store credit or refund.";
      completionTokens = 25;
    } else if (task === 'summarize') {
      responseText = "Summary: Jane Doe reported double charge on order #4812 and asked for a refund.";
      completionTokens = 25;
    } else if (task === 'extract') {
      structuredData = {
        user_id: "US-9921",
        action: "cancel_subscription",
        plan: "Pro Annual",
        sentiment: "negative"
      };
      responseText = JSON.stringify(structuredData);
      completionTokens = 25;
    } else if (task === 'tool') {
      // Intentional tool-calling regression in Model B
      if (req.message.toLowerCase().includes('refund')) {
        toolCalls = [{
          name: 'query_refund_status',
          arguments: { order_id: "ORD-9841", reason: "status" } // string instead of number
        }];
      } else {
        toolCalls = [{
          name: 'create_ticket',
          arguments: {
            order_id: "ORD-4812", // String instead of integer!
            user_id: "US-9921",
            issue_type: "refund_request", // Invalid enum!
            priority: "normal" // Invalid enum!
          }
        }];
      }
      responseText = "Created ticket with standard values.";
      completionTokens = 20;
    }
  }

  const durationMs = Date.now() - startTime;
  const metrics = MODEL_METRICS[targetModelKey] ?? MODEL_METRICS['model-a'];
  const cost = (promptTokens / 1000) * metrics.cost_per_1k_input + (completionTokens / 1000) * metrics.cost_per_1k_output;

  return {
    response: responseText,
    model_used: targetModelKey,
    task,
    tool_calls: toolCalls,
    structured_data: structuredData,
    latency_ms: durationMs,
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      estimated_cost: cost,
    },
  };
}
