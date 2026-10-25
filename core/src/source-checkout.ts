import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Un checkout del motor contiene el código fuente del CLI que publica el paquete.
 * Un repositorio consumidor instala el arnés y no tiene `core/src`.
 *
 * La distinción separa el taller del mantenedor del ambiente de instalación:
 * en el primero OpenSpec y los destinos de agente son legítimos, en el segundo no.
 */
export async function isEngineCheckout(root: string): Promise<boolean> {
  try {
    await fs.access(path.join(root, 'core', 'package.json'));
    await fs.access(path.join(root, 'core', 'src', 'paths.ts'));
    return true;
  } catch {
    return false;
  }
}
