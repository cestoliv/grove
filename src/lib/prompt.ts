import { createInterface } from 'node:readline';

export interface ConfirmOptions {
  question: string;
  input?: NodeJS.ReadableStream;
  write?: (text: string) => void;
  // Diagnostics go to stderr, so a caller that pipes stdout still sees them.
  warn?: (text: string) => void;
  assumeYes?: boolean;
  isTty?: boolean;
}

const YES = /^(y|yes)$/i;

export async function confirm(options: ConfirmOptions): Promise<boolean> {
  if (options.assumeYes === true) {
    return true;
  }

  const write = options.write ?? ((text: string) => console.log(text));
  const warn = options.warn ?? ((text: string) => console.error(text));
  const isTty = options.isTty ?? process.stdin.isTTY === true;
  // A pipe cannot answer, and a silent yes there would destroy runners nobody
  // agreed to lose.
  if (!isTty) {
    warn(
      'grove needs a yes to continue, and stdin is not a terminal. Rerun with --yes.',
    );
    return false;
  }

  write(options.question);
  const reader = createInterface({
    input: options.input ?? process.stdin,
    terminal: false,
  });
  try {
    for await (const line of reader) {
      return YES.test(line.trim());
    }
    return false;
  } finally {
    reader.close();
  }
}
