#!/usr/bin/env node
import { runCli } from '../cli/run.js';

runCli(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error inesperado: ${message}\n`);
    process.exitCode = 1;
  });
