import type { StreamChunk, ToolDefinition } from '@agent-os/shared';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages.js';
export declare class MockClaudeClient {
    private readonly responses;
    private callIndex;
    constructor(responses?: StreamChunk[][]);
    stream(_messages: MessageParam[], _system: string, _tools?: ToolDefinition[]): AsyncGenerator<StreamChunk>;
}
//# sourceMappingURL=anthropic.d.ts.map