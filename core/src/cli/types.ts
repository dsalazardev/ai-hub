import type { AiHubSource } from '../paths.js';

export interface CliIO {
  out(message: string): void;
  err(message: string): void;
}

export interface CliContext {
  cwd: string;
  root: string;
  source: AiHubSource | null;
  io: CliIO;
}

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

export type CommandHandler = (args: ParsedArgs, ctx: CliContext) => Promise<number>;

export const processIO: CliIO = {
  out: (message) => process.stdout.write(`${message}\n`),
  err: (message) => process.stderr.write(`${message}\n`),
};
