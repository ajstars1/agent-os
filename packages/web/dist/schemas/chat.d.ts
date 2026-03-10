import { z } from 'zod';
export declare const ChatRequestSchema: z.ZodObject<{
    message: z.ZodString;
    conversationId: z.ZodOptional<z.ZodString>;
    model: z.ZodOptional<z.ZodEnum<["claude", "gemini", "auto"]>>;
    agentName: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    message: string;
    conversationId?: string | undefined;
    model?: "claude" | "gemini" | "auto" | undefined;
    agentName?: string | undefined;
}, {
    message: string;
    conversationId?: string | undefined;
    model?: "claude" | "gemini" | "auto" | undefined;
    agentName?: string | undefined;
}>;
export type ChatRequest = z.infer<typeof ChatRequestSchema>;
//# sourceMappingURL=chat.d.ts.map