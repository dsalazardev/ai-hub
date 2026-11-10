import type { AiHubSource } from '../paths.js';
import type { ProcessRunner } from '../speckit/runner.js';
import type { AssistantPrompts } from './assistant.js';
import type { ResolverHost } from '../control/hermes.js';
import type { DiscordFetch } from '../control/onboard.js';
import type { EditorHost, IdeaStdin } from './idea.js';

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
  /** control-onboarding: host del resolver de Hermes, API de Discord y stdin inyectables (tests). */
  controlHost?: ResolverHost;
  discordFetch?: DiscordFetch;
  stdin?: () => Promise<string>;
  /** idea-input: entrada estándar de `--idea-stdin` y host del editor de `--idea-editor`, inyectables (tests). */
  ideaStdin?: IdeaStdin;
  editorHost?: EditorHost;
}

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
  /** Tokens que siguen al primer `--`, sin interpretar (para comandos que lanzan otro proceso). */
  passthrough?: string[];
}

export type CommandHandler = (args: ParsedArgs, ctx: CliContext) => Promise<number>;

export const processIO: CliIO = {
  out: (message) => process.stdout.write(`${message}\n`),
  err: (message) => process.stderr.write(`${message}\n`),
};
