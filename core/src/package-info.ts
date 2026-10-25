import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

interface OwnPackage {
  name: string;
  version: string;
}

const own = require('../package.json') as OwnPackage;

/** Nombre con el que se publica este paquete. Derivado del package.json, nunca hardcodeado. */
export const PACKAGE_NAME = own.name;

/** Versión del paquete en ejecución. */
export const PACKAGE_VERSION = own.version;
