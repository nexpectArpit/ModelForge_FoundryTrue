import { z } from 'zod';

export const CreateTicketSchema = z.object({
  order_id: z.number().int().positive({ message: "order_id must be an integer" }),
  user_id: z.string().min(3),
  issue_type: z.enum(['billing', 'shipping', 'technical', 'other']),
  priority: z.enum(['low', 'medium', 'high', 'urgent']),
});

export const QueryRefundStatusSchema = z.object({
  order_id: z.number().int().positive({ message: "order_id must be an integer" }),
  reason: z.string().min(5),
});

export type CreateTicketArgs = z.infer<typeof CreateTicketSchema>;
export type QueryRefundStatusArgs = z.infer<typeof QueryRefundStatusSchema>;

export const SUPPORT_TOOLS = [
  {
    name: 'create_ticket',
    description: 'Create an internal support ticket with validated priority and issue type.',
    parameters: {
      type: 'object',
      properties: {
        order_id: { type: 'integer', description: 'Numeric Order ID' },
        user_id: { type: 'string', description: 'Customer identifier' },
        issue_type: { type: 'string', enum: ['billing', 'shipping', 'technical', 'other'] },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
      },
      required: ['order_id', 'user_id', 'issue_type', 'priority'],
    },
  },
  {
    name: 'query_refund_status',
    description: 'Check refund processing status for a specific numerical order ID.',
    parameters: {
      type: 'object',
      properties: {
        order_id: { type: 'integer', description: 'Numeric Order ID' },
        reason: { type: 'string', description: 'Reason for refund inquiry' },
      },
      required: ['order_id', 'reason'],
    },
  },
];
