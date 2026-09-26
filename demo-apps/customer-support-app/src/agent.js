import { getConfig, MODEL_METRICS } from './config.js';
function detectTask(message, hint) {
    if (hint)
        return hint;
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
export async function processChat(req) {
    const startTime = Date.now();
    const task = detectTask(req.message, req.task_hint);
    const currentConfig = getConfig();
    // Determine which model serves this task based on routing mode
    let targetModel = currentConfig.active_model;
    if (currentConfig.routing_mode === 'hybrid') {
        // Hybrid routing strategy:
        // Tool calls stay on high-reliability model-a, bulk QA/summarize/extract go to cost-efficient model-b
        targetModel = task === 'tool' ? 'model-a' : 'model-b';
    }
    // Model-specific execution simulation
    let responseText = '';
    let toolCalls = [];
    let structuredData = null;
    let promptTokens = Math.max(20, Math.floor(req.message.length / 4));
    let completionTokens = 40;
    if (targetModel === 'model-a') {
        // Model A: High quality, strict adherence, baseline latency (~350ms in mock)
        await new Promise(r => setTimeout(r, 60)); // Fast mock delay
        if (task === 'qa') {
            responseText = "Our standard policy allows returns within 30 days of purchase for a full refund or store credit. Opened electronics must include all original packaging and accessories.";
            completionTokens = 35;
        }
        else if (task === 'summarize') {
            responseText = "Summary: Customer Jane Doe experienced double-charging on order #4812 due to a payment gateway timeout. She requested an immediate refund and priority escalation.";
            completionTokens = 45;
        }
        else if (task === 'extract') {
            structuredData = {
                user_id: "US-9921",
                action: "cancel_subscription",
                plan: "Pro Annual",
                sentiment: "negative"
            };
            responseText = JSON.stringify(structuredData);
            completionTokens = 30;
        }
        else if (task === 'tool') {
            // Model A produces perfectly schema-conforming tool arguments
            if (req.message.toLowerCase().includes('refund')) {
                toolCalls = [{
                        name: 'query_refund_status',
                        arguments: { order_id: 9841, reason: "Customer requested expedited refund review" }
                    }];
            }
            else {
                toolCalls = [{
                        name: 'create_ticket',
                        arguments: { order_id: 4812, user_id: "US-9921", issue_type: "billing", priority: "high" }
                    }];
            }
            responseText = "I have initiated the required support action through the system tool.";
            completionTokens = 25;
        }
    }
    else {
        // Model B: Cost-efficient, fast (~15ms in mock)
        await new Promise(r => setTimeout(r, 15));
        if (task === 'qa') {
            responseText = "Our store policy allows returning opened items within 30 days with original packaging for store credit or refund.";
            completionTokens = 25;
        }
        else if (task === 'summarize') {
            responseText = "Summary: Jane Doe reported double charge on order #4812 and asked for a refund.";
            completionTokens = 25;
        }
        else if (task === 'extract') {
            structuredData = {
                user_id: "US-9921",
                action: "cancel_subscription",
                plan: "Pro Annual",
                sentiment: "negative"
            };
            responseText = JSON.stringify(structuredData);
            completionTokens = 25;
        }
        else if (task === 'tool') {
            // REGRESSION BEHAVIOR IN MODEL B:
            // Model B fails structured tool schema constraints!
            // Emits string order_id instead of integer, invalid issue_type, and invalid priority enum
            if (req.message.toLowerCase().includes('refund')) {
                toolCalls = [{
                        name: 'query_refund_status',
                        arguments: { order_id: "ORD-9841", reason: "status" } // order_id is string!
                    }];
            }
            else {
                toolCalls = [{
                        name: 'create_ticket',
                        arguments: {
                            order_id: "ORD-4812", // String instead of integer!
                            user_id: "US-9921",
                            issue_type: "refund_request", // Invalid enum! (Must be billing|shipping|technical|other)
                            priority: "normal" // Invalid enum! (Must be low|medium|high|urgent)
                        }
                    }];
            }
            responseText = "Created ticket with standard values.";
            completionTokens = 20;
        }
    }
    const durationMs = Date.now() - startTime;
    const metrics = MODEL_METRICS[targetModel] ?? MODEL_METRICS['model-a'];
    const cost = (promptTokens / 1000) * metrics.cost_per_1k_input + (completionTokens / 1000) * metrics.cost_per_1k_output;
    return {
        response: responseText,
        model_used: targetModel,
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
