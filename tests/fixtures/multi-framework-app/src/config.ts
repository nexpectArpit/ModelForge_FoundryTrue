export const config = {
  active_model: process.env.APP_MODEL ?? 'gpt-4o',
  routing_mode: (process.env.APP_ROUTING_MODE as 'direct' | 'hybrid') ?? 'direct',
  port: Number(process.env.PORT ?? 3000),
};
