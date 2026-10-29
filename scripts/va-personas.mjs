import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
export function vaExternalPlan(rest, flags, fail) {
  const [action, file] = rest;
  if (action === 'ver') return { method: 'GET', route: 'va/external' };
  if (!['importar', 'aplicar'].includes(action) || !file) fail('Uso: va-personas importar|aplicar fichero.json');
  const bytes = readFileSync(file),
    raw = JSON.parse(bytes.toString('utf8'));
  if (!Array.isArray(raw?.entries) || !raw.entries.length)
    fail('El JSON debe incluir entries con las personas sin equipo');
  if (action === 'aplicar' && !flags['review-token']) fail('aplicar necesita --review-token de la vista previa');
  return {
    method: 'POST',
    route: 'va/external',
    body: {
      action: action === 'importar' ? 'preview' : 'apply',
      entries: raw.entries,
      source: { title: flags.title ?? path.basename(file), sha256: createHash('sha256').update(bytes).digest('hex') },
      ...(action === 'aplicar' ? { reviewToken: flags['review-token'] } : {}),
    },
  };
}
