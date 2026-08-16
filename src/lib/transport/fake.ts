import type {
  ExecOptions,
  ExecResult,
  RecordedCall,
  Transport,
} from './types.js';

interface ScriptEntry {
  prefix: string;
  result?: ExecResult;
  error?: string;
}

function fill(partial: Partial<ExecResult>): ExecResult {
  return { code: 0, stdout: '', stderr: '', ...partial };
}

export class FakeTransport implements Transport {
  readonly name: string;
  readonly calls: RecordedCall[] = [];
  readonly writes = new Map<string, string>();
  closed = false;

  private readonly script: ScriptEntry[] = [];
  private readonly files = new Map<string, string>();
  private fallbackResult: ExecResult = fill({});

  constructor(name = 'fake') {
    this.name = name;
  }

  on(prefix: string, result: Partial<ExecResult>): this {
    this.script.push({ prefix, result: fill(result) });
    return this;
  }

  fail(prefix: string, stderr: string, code = 255): this {
    return this.on(prefix, { code, stderr });
  }

  throwOn(prefix: string, message: string): this {
    this.script.push({ prefix, error: message });
    return this;
  }

  setFallback(result: Partial<ExecResult>): this {
    this.fallbackResult = fill(result);
    return this;
  }

  file(path: string, content: string): this {
    this.files.set(path, content);
    return this;
  }

  commandLines(): string[] {
    return this.calls.map((call) => [call.command, ...call.args].join(' '));
  }

  async exec(
    command: string,
    args: string[],
    options?: ExecOptions,
  ): Promise<ExecResult> {
    this.calls.push({ command, args, options });
    const line = [command, ...args].join(' ');
    const entry = this.script.find((candidate) =>
      line.startsWith(candidate.prefix),
    );
    if (entry === undefined) {
      return this.fallbackResult;
    }
    if (entry.error !== undefined) {
      throw new Error(entry.error);
    }
    return entry.result ?? this.fallbackResult;
  }

  async readFile(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) {
      throw new Error(`FakeTransport has no file at ${path}`);
    }
    return content;
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.writes.set(path, content);
    this.files.set(path, content);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
