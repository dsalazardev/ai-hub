import type { AiHubSource } from '../paths.js';
import type { ProcessRunner } from '../speckit/runner.js';
import type { AssistantPrompts } from './assistant.js';

export interface CliIO {
  out(message: string): void;
  err(message: string): void;
}

export interface CliContext {
  cwd: string;
  root: string;
  source: AiHubSource | null;
  io: CliIO;
  /** Ejecutor de procesos externos (uvx, bash); los tests lo sustituyen. */
  exec: ProcessRunner;
  /** TTY inyectable para tests (design D3); ausente = decidir por process.stdout/stdin. */
  interactive?: boolean;
  /** Prompts del asistente (design D13); ausente = adaptador clack, sólo con TTY real. */
  assistantPrompts?: AssistantPrompts;
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
