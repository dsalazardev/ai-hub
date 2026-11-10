import * as p from '@clack/prompts';
import { isCancel } from '@clack/prompts';
import { renderBanner } from './banner.js';
import type { AssistantPrompts, PromptOption } from './assistant.js';
import { ideaFromEditor, readIdeaFromTerminal, realEditorHost } from './idea.js';

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

/** Modo de color del terminal para el banner (neon-banner D1): el sondeo vive aquí. */
function bannerMode(): 'truecolor' | '256' | 'none' {
  if ((process.env.NO_COLOR ?? '') !== '') return 'none';
  const colorTerm = (process.env.COLORTERM ?? '').toLowerCase();
  if (colorTerm === 'truecolor' || colorTerm === '24bit') return 'truecolor';
  return '256';
}

export const clackPrompts: AssistantPrompts = {
  intro: (title, version) => {
    // Banner de identidad (neon-banner D1–D5): antes de la intro de clack. El
    // ancho sale del terminal con fallback seguro; el modo de color se sondea
    // aquí (NO_COLOR apaga todo; COLORTERM truecolor/24bit sube a truecolor;
    // el piso es 256) y la versión del paquete la pasa el colector. Este módulo
    // sólo se carga tras el gate de TTY: ningún byte de banner en salida pipeada.
    process.stdout.write(
      `${renderBanner(process.stdout.columns ?? 80, bannerMode(), version)}\n`,
    );
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
  // Paso opt-in del tracker (PD-1): entrada enmascarada; el valor no se muestra ni se registra.
  password: async (message) => {
    const value = await p.password({ message });
    return isCancel(value) ? null : (value ?? '');
  },
  // idea-input (D1): lector propio con bracketed paste, render acotado y drenado; Ctrl+E abre el editor (D7).
  longText: async (message, { maxBytes, root }) =>
    readIdeaFromTerminal(process.stdin, process.stdout, {
      message,
      maxBytes,
      editor: () => ideaFromEditor(realEditorHost(root), maxBytes),
    }),
};
