import { z } from 'zod';
export declare const AgentProfileSchema: z.ZodObject<{
    name: z.ZodString;
    systemPrompt: z.ZodOptional<z.ZodString>;
    defaultModel: z.ZodDefault<z.ZodEnum<["claude", "gemini", "auto"]>>;
    skills: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    mcpConfigPath: z.ZodOptional<z.ZodString>;
    maxTokens: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    name: string;
    defaultModel: "claude" | "gemini" | "auto";
    skills: string[];
    systemPrompt?: string | undefined;
    mcpConfigPath?: string | undefined;
    maxTokens?: number | undefined;
}, {
    name: string;
    systemPrompt?: string | undefined;
    defaultModel?: "claude" | "gemini" | "auto" | undefined;
    skills?: string[] | undefined;
    mcpConfigPath?: string | undefined;
    maxTokens?: number | undefined;
}>;
export type AgentProfile = z.infer<typeof AgentProfileSchema>;
//# sourceMappingURL=types.d.ts.map