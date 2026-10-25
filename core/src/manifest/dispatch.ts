import type { EngineCommand, EngineManifest, Lane } from '../engine/engine.js';

export class UnknownSpecCommandError extends Error {
  constructor(readonly commandId: string) {
    super(`comando de Spec Kit desconocido: ${commandId}`);
    this.name = 'UnknownSpecCommandError';
  }
}

export class RoleMismatchError extends Error {
  constructor(
    readonly commandId: string,
    readonly expected: string[],
    readonly received: string,
  ) {
    super(
      `el comando "${commandId}" pertenece a ${expected.join(', ')}; el rol recibido fue "${received}"`,
    );
    this.name = 'RoleMismatchError';
  }
}

export function resolveCommand(
  engine: EngineManifest,
  commandId: string,
  roleId: string,
): EngineCommand {
  const command = engine.commands.find((item) => item.id === commandId);
  if (!command) {
    throw new UnknownSpecCommandError(commandId);
  }
  const allowed = [command.role, ...(command.co_roles ?? [])];
  if (!allowed.includes(roleId)) {
    throw new RoleMismatchError(command.id, allowed, roleId);
  }
  return command;
}

export function commandsByLane(engine: EngineManifest, lane: Lane): EngineCommand[] {
  return engine.commands
    .filter((command) => command.lane === lane)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
