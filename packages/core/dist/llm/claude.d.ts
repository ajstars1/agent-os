import type { MessageParam } from '@anthropic-ai/sdk/resources/messages.js';
import type { StreamChunk, ToolDefinition } from '@agent-os/shared';
export declare class ClaudeClient {
    private readonly client;
    constructor(apiKey: string);
    stream(messages: MessageParam[], systemPrompt: string, tools?: ToolDefinition[]): AsyncGenerator<StreamChunk>;
}
//# sourceMappingURL=claude.d.ts.map