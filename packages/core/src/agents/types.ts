import { z } from 'zod';

export const AgentProfileSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/, 'Name must be lowercase alphanumeric with hyphens'),
  systemPrompt: z.string().optional(),
  defaultModel: z.enum(['claude', 'gemini', 'auto']).default('auto'),
  skills: z.array(z.string()).default([]),
  mcpConfigPath: z.string().optional(),
  maxTokens: z.number().int().min(256).max(32_768).optional(),
});

export type AgentProfile = z.infer<typeof AgentProfileSchema>;
