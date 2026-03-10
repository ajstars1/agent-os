import { z } from 'zod';

export const ChatRequestSchema = z.object({
  message: z.string().min(1).max(32_000),
  conversationId: z.string().uuid().optional(),
  model: z.enum(['claude', 'gemini', 'auto']).optional(),
  agentName: z.string().optional(),
});

export type ChatRequest = z.infer<typeof ChatRequestSchema>;
