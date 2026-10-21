import fs from 'node:fs/promises';
import path from 'node:path';

export interface CheckResult {
  pass: boolean;
  violations: string[];
}

async function findSpecFiles(changeDir: string): Promise<string[]> {
  const specsDir = path.join(changeDir, 'specs');
  const files: string[] = [];

  try {
    const entries = await fs.readdir(specsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const specFile = path.join(specsDir, entry.name, 'spec.md');
        try {
          await fs.access(specFile);
          files.push(specFile);
        } catch {
          // spec.md no existe en este subdirectorio
        }
      }
    }
  } catch {
    return files;
  }

  return files;
}

function extractRequirementNames(content: string): string[] {
  const names: string[] = [];
  const regex = /^###\s+Requirement:\s+(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    names.push(match[1].trim());
  }
  return names;
}

export async function checkEarsRequirements(changeDir: string): Promise<CheckResult> {
  const violations: string[] = [];

  let specFiles: string[];
  try {
    specFiles = await findSpecFiles(changeDir);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { pass: false, violations: [`Error leyendo specs/: ${msg}`] };
  }

  if (specFiles.length === 0) {
    return { pass: false, violations: ['No se encontraron archivos spec.md en specs/'] };
  }

  for (const specFile of specFiles) {
    let content: string;
    try {
      content = await fs.readFile(specFile, 'utf8');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      violations.push(`Error leyendo ${specFile}: ${msg}`);
      continue;
    }

    const requirements = extractRequirementNames(content);
    if (requirements.length === 0) {
      const relPath = specFile.replace(changeDir + '/', '');
      violations.push(`${relPath}: sin requisitos EARS (### Requirement:)`);
    }
  }

  return { pass: violations.length === 0, violations };
}

export async function checkScenariosExist(changeDir: string): Promise<CheckResult> {
  const violations: string[] = [];

  let specFiles: string[];
  try {
    specFiles = await findSpecFiles(changeDir);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { pass: false, violations: [`Error leyendo specs/: ${msg}`] };
  }

  for (const specFile of specFiles) {
    let content: string;
    try {
      content = await fs.readFile(specFile, 'utf8');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      violations.push(`Error leyendo ${specFile}: ${msg}`);
      continue;
    }

    const relPath = specFile.replace(changeDir + '/', '');
    const lines = content.split('\n');
    let currentRequirement: string | null = null;
    let hasScenario = false;

    for (const line of lines) {
      if (/^###\s+Requirement:/.test(line)) {
        if (currentRequirement !== null && !hasScenario) {
          violations.push(`Requirement: ${currentRequirement} en ${relPath} no tiene escenarios`);
        }
        currentRequirement = line.replace(/^###\s+Requirement:\s*/, '').trim();
        hasScenario = false;
      } else if (/^####\s+Scenario:/.test(line)) {
        hasScenario = true;
      }
    }
    // Verificar el último requirement del archivo
    if (currentRequirement !== null && !hasScenario) {
      violations.push(`Requirement: ${currentRequirement} en ${relPath} no tiene escenarios`);
    }
  }

  return { pass: violations.length === 0, violations };
}

export async function checkTasksCoverRequirements(changeDir: string): Promise<CheckResult> {
  const violations: string[] = [];

  // Leer tasks.md
  const tasksPath = path.join(changeDir, 'tasks.md');
  let tasksContent: string;
  try {
    tasksContent = await fs.readFile(tasksPath, 'utf8');
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { pass: false, violations: [`Error leyendo tasks.md: ${msg}`] };
  }

  // Recopilar todos los requirement names de los specs
  let specFiles: string[];
  try {
    specFiles = await findSpecFiles(changeDir);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { pass: false, violations: [`Error leyendo specs/: ${msg}`] };
  }

  for (const specFile of specFiles) {
    let content: string;
    try {
      content = await fs.readFile(specFile, 'utf8');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      violations.push(`Error leyendo ${specFile}: ${msg}`);
      continue;
    }

    const requirements = extractRequirementNames(content);
    for (const reqName of requirements) {
      if (!tasksContent.includes(reqName)) {
        violations.push(`Requirement: ${reqName} no referenciado en tasks.md`);
      }
    }
  }

  return { pass: violations.length === 0, violations };
}
