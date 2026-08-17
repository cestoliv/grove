import type {
  ExecOptions,
  ExecResult,
  RecordedCall,
  Transport,
} from './types.js';

interface ScriptEntry {
  prefix: string;
  result?: ExecResult;
  // Answers for the first calls that match, in order. The last one stands
  // for every call after them, so a script never runs out.
  sequence?: ExecResult[];
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

  /**
   * One answer per call, for a command grove asks twice and expects to answer
   * differently, such as a `launchctl print` that reports a label still there
   * and then gone. The last answer repeats once the list runs out.
   */
  onEach(prefix: string, results: Partial<ExecResult>[]): this {
    if (results.length === 0) {
      throw new Error('FakeTransport.onEach needs at least one result');
    }
    this.script.push({ prefix, sequence: results.map(fill) });
    return this;
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
    if (entry?.error !== undefined) {
      throw new Error(entry.error);
    }
    const queued =
      entry?.sequence === undefined
        ? undefined
        : entry.sequence.length > 1
          ? entry.sequence.shift()
          : entry.sequence[0];
    const result = queued ?? entry?.result ?? this.fallbackResult;
    if (result.stdout !== '') {
      options?.onStdout?.(result.stdout);
    }
    if (result.stderr !== '') {
      options?.onStderr?.(result.stderr);
    }
    return result;
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
