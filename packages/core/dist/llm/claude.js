import Anthropic from '@anthropic-ai/sdk';
export class ClaudeClient {
    client;
    constructor(apiKey) {
        this.client = new Anthropic({ apiKey });
    }
    async *stream(messages, systemPrompt, tools) {
        const anthropicTools = tools?.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.inputSchema,
        }));
        const stream = this.client.messages.stream({
            model: 'claude-sonnet-4-5',
            max_tokens: 8192,
            system: systemPrompt,
            messages,
            ...(anthropicTools && anthropicTools.length > 0 ? { tools: anthropicTools } : {}),
        });
        // Buffer for tool input JSON (streamed in fragments)
        const toolInputBuffers = new Map();
        const toolCallsByIndex = new Map();
        for await (const event of stream) {
            if (event.type === 'content_block_start') {
                if (event.content_block.type === 'tool_use') {
                    toolCallsByIndex.set(event.index, {
                        id: event.content_block.id,
                        name: event.content_block.name,
                    });
                    toolInputBuffers.set(event.index, '');
                }
            }
            else if (event.type === 'content_block_delta') {
                if (event.delta.type === 'text_delta') {
                    yield { type: 'text', content: event.delta.text };
                }
                else if (event.delta.type === 'input_json_delta') {
                    const existing = toolInputBuffers.get(event.index) ?? '';
                    toolInputBuffers.set(event.index, existing + event.delta.partial_json);
                }
            }
            else if (event.type === 'content_block_stop') {
                const toolMeta = toolCallsByIndex.get(event.index);
                if (toolMeta) {
                    const jsonStr = toolInputBuffers.get(event.index) ?? '{}';
                    let input = {};
                    try {
                        input = JSON.parse(jsonStr);
                    }
                    catch {
                        input = {};
                    }
                    const toolCall = { id: toolMeta.id, name: toolMeta.name, input };
                    yield { type: 'tool_call', toolCall };
                    toolCallsByIndex.delete(event.index);
                    toolInputBuffers.delete(event.index);
                }
            }
            else if (event.type === 'message_delta' && event.usage) {
                yield {
                    type: 'usage',
                    usage: {
                        inputTokens: 0,
                        outputTokens: event.usage.output_tokens,
                    },
                };
            }
            else if (event.type === 'message_start' && event.message.usage) {
                yield {
                    type: 'usage',
                    usage: {
                        inputTokens: event.message.usage.input_tokens,
                        outputTokens: event.message.usage.output_tokens,
                    },
                };
            }
        }
        yield { type: 'done' };
    }
}
//# sourceMappingURL=claude.js.map