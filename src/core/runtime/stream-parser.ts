/**
 * 流式输出解析 — 解析 Claude Agent SDK 的 SSE 流事件，提取文本增量和工具调用。
 */
export interface StreamParserCallbacks {
  onTextDelta?: (text: string) => void;
  onToolUse?: (name: string, input: Record<string, unknown>) => void;
}

export class StreamParser {
  private callbacks: StreamParserCallbacks;
  private currentToolName: string | null = null;
  private currentToolInput = '';
  private blockTypes = new Map<number, string>();

  constructor(callbacks: StreamParserCallbacks) {
    this.callbacks = callbacks;
  }

  feed(event: unknown) {
    const payload = event as Record<string, unknown>;
    const eventType = payload.type;
    const index = typeof payload.index === 'number' ? payload.index : 0;

    if (eventType === 'content_block_start') {
      const contentBlock = payload.content_block as Record<string, unknown> | undefined;
      const blockType = typeof contentBlock?.type === 'string' ? contentBlock.type : '';
      this.blockTypes.set(index, blockType);
      if (blockType === 'tool_use') {
        this.currentToolName =
          typeof contentBlock?.name === 'string' ? contentBlock.name : 'unknown';
        this.currentToolInput = '';
      }
      return;
    }

    if (eventType === 'content_block_delta') {
      const delta = payload.delta as Record<string, unknown> | undefined;
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        this.callbacks.onTextDelta?.(delta.text);
      } else if (
        delta?.type === 'input_json_delta' &&
        typeof delta.partial_json === 'string'
      ) {
        this.currentToolInput += delta.partial_json;
      }
      return;
    }

    if (eventType === 'content_block_stop') {
      const blockType = this.blockTypes.get(index);
      if (blockType === 'tool_use' && this.currentToolName) {
        let parsed: Record<string, unknown> = {};
        if (this.currentToolInput) {
          try {
            parsed = JSON.parse(this.currentToolInput) as Record<string, unknown>;
          } catch {
            parsed = { raw: this.currentToolInput };
          }
        }
        this.callbacks.onToolUse?.(this.currentToolName, parsed);
      }
      this.blockTypes.delete(index);
      this.currentToolName = null;
      this.currentToolInput = '';
    }
  }
}
