// Ratchet de rechazos (taller, R-062, R-063): extrae de forma estructural, con la API de TypeScript, los
// diagnósticos de rechazo o fallo dirigidos al operador. No viaja en el paquete (`files` no incluye `scripts/`).
//   - `throw new <Error>(<mensaje>)`
//   - `<algo>.err(<mensaje>)` (flujo de error del CLI)
//   - `return { code: <N > 0>, lines: [<línea>, …] }` (resultado de fallo con líneas)
// Excluye la salida de éxito o informativa (`io.out`, resultados con `code: 0`). Los valores dinámicos se
// normalizan a `{}`; un mensaje sin texto fijo (solo `{}`) no aporta una plantilla revisable y no se registra.
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/** Plantilla normalizada de una expresión de mensaje, o null si no es texto. */
export function template(node) {
  if (!node) {
    return null;
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map((span) => `{}${span.literal.text}`).join('');
  }
  if (ts.isParenthesizedExpression(node)) {
    return template(node.expression);
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return `${template(node.left) ?? '{}'}${template(node.right) ?? '{}'}`;
  }
  if (ts.isConditionalExpression(node)) {
    // Dos ramas, dos plantillas: se unen con « | » para que ambas queden revisadas.
    const both = [template(node.whenTrue), template(node.whenFalse)].filter((item) => item !== null);
    return both.length > 0 ? both.join(' | ') : null;
  }
  return null;
}

function normalize(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function meaningful(text) {
  return text !== null && /[A-Za-zÁÉÍÓÚáéíóúñÑ]/.test(text.replace(/\{\}/g, ''));
}

/** Rechazos de un archivo fuente. `file` es la ruta relativa que se registra. */
export function extractRefusals(source, file) {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found = [];
  const push = (emitter, node) => {
    const text = template(node);
    if (meaningful(text)) {
      found.push({ file, emitter, template: normalize(text) });
    }
  };
  const visit = (node) => {
    if (ts.isThrowStatement(node) && node.expression && ts.isNewExpression(node.expression)) {
      const name = node.expression.expression.getText(sf);
      // Un error con código y mensaje (`new X(code, mensaje)`): se registra el argumento con más texto fijo.
      const args = [...(node.expression.arguments ?? [])];
      const best = args
        .map((arg) => ({ arg, text: template(arg) }))
        .filter((item) => meaningful(item.text))
        .sort((a, b) => b.text.replace(/\{\}/g, '').length - a.text.replace(/\{\}/g, '').length)[0];
      push(`throw ${name}`, best?.arg);
    } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'err') {
      push('io.err', node.arguments[0]);
    } else if (ts.isReturnStatement(node) && node.expression && ts.isObjectLiteralExpression(node.expression)) {
      const props = new Map(
        node.expression.properties.filter(ts.isPropertyAssignment).map((prop) => [prop.name.getText(sf), prop.initializer]),
      );
      const code = props.get('code');
      const lines = props.get('lines');
      if (code && ts.isNumericLiteral(code) && Number(code.text) > 0 && lines && ts.isArrayLiteralExpression(lines)) {
        for (const element of lines.elements) {
          push(`return code ${code.text}`, element);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

const key = (item) => `${item.file}\u0000${item.emitter}\u0000${item.template}`;

/** Todos los rechazos de `srcDir`, ordenados y sin duplicados. */
export function scanRefusals(srcDir) {
  const out = new Map();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        const rel = path.relative(srcDir, full).split(path.sep).join('/');
        for (const item of extractRefusals(fs.readFileSync(full, 'utf8'), rel)) {
          out.set(key(item), item);
        }
      }
    }
  };
  walk(srcDir);
  return [...out.values()].sort((a, b) => key(a).localeCompare(key(b)));
}

/** Comparación con la línea base: los nuevos fallan; los retirados pasan. */
export function compareRefusals(current, baseline) {
  const known = new Set(baseline.map(key));
  const now = new Set(current.map(key));
  return {
    added: current.filter((item) => !known.has(key(item))),
    removed: baseline.filter((item) => !now.has(key(item))),
  };
}
