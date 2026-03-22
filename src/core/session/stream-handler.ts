/**
 * StreamHandler — 缓冲区管理，收集 Claude 流式输出文本。
 * 从 ClaudeSession 拆分而来，可独立实例化和单元测试。
 */

export class StreamHandler {
  private readonly bufferMaxChars: number;
  private buffer = '';

  constructor(config: { bufferMaxChars: number }) {
    this.bufferMaxChars = config.bufferMaxChars;
  }

  appendText(text: string): void {
    this.buffer += text;
    if (this.buffer.length > this.bufferMaxChars) {
      this.buffer = this.buffer.slice(-this.bufferMaxChars);
    }
  }

  getBuffer(): string {
    return this.buffer;
  }

  reset(): void {
    this.buffer = '';
  }
}
