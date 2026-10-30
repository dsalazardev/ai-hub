import * as p from '@clack/prompts';
import { isCancel } from '@clack/prompts';
import { renderBanner } from './banner.js';
import type { AssistantPrompts, PromptOption } from './assistant.js';

function toOptions(options: PromptOption[]): p.Option<string>[] {
  return options.map((option) => ({
    value: option.value,
    label: option.label,
    ...(option.hint !== undefined ? { hint: option.hint } : {}),
  }));
}

/**
 * Adaptador clack de los prompts del asistente (design D1). Sólo se carga con TTY real:
 * `cmdInit` lo importa en diferido tras el gate (design D3), así que el flujo no
 * interactivo ni lo carga. La cancelación se traduce a `null`; el mensaje de cancelación
 * lo imprime el colector, que retorna antes de cualquier escritura (R5).
 */
export const clackPrompts: AssistantPrompts = {
  intro: (title) => {
    // Banner de identidad (design D8): antes de la intro de clack. El ancho sale del
    // terminal con fallback seguro; NO_COLOR (presente y no vacío) apaga los escapes.
    // Este módulo sólo se carga tras el gate de TTY: ningún byte de banner en salida pipeada.
    const noColor = (process.env.NO_COLOR ?? '') !== '';
    process.stdout.write(`${renderBanner(process.stdout.columns ?? 80, !noColor)}\n`);
    p.intro(title);
  },
  note: (message) => {
    p.note(message);
  },
  multiselect: async (message, options, initial) => {
    const value = await p.multiselect({ message, options: toOptions(options), initialValues: initial });
    return isCancel(value) ? null : value;
  },
  select: async (message, options, initial) => {
    const value = await p.select({
      message,
      options: toOptions(options),
      ...(initial !== undefined ? { initialValue: initial } : {}),
    });
    return isCancel(value) ? null : value;
  },
  text: async (message) => {
    const value = await p.text({ message });
    return isCancel(value) ? null : value;
  },
  confirm: async (message) => {
    const value = await p.confirm({ message });
    return isCancel(value) ? null : value === true;
  },
};
