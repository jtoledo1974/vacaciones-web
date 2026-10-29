import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

/** Explicit RRHH order, never inferred from the team rosters. */
export function vaCensusPlan(rest, flags, fail) {
  const [action, file] = rest;
  if (action === 'ver') {
    const year = Number(flags.year);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) fail('Indica --year AAAA');
    return { method: 'GET', route: 'va/election/' + flags.year };
  }
  if (!['importar', 'aplicar'].includes(action) || !file)
    fail('Uso: va-censo importar|aplicar fichero.json --year AAAA');
  const bytes = readFileSync(file),
    raw = JSON.parse(bytes.toString('utf8'));
  if (!raw || typeof raw !== 'object') fail('El fichero debe contener un objeto JSON con people');
  const year = Number(flags.year ?? raw.year);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) fail('Indica --year AAAA');
  if (
    !Array.isArray(raw.people) ||
    !raw.people.length ||
    raw.people.some((id) => typeof id !== 'string') ||
    new Set(raw.people).size !== raw.people.length
  )
    fail('people debe contener identificadores de persona en el orden de RRHH, sin duplicados');
  if (action === 'aplicar' && !flags['review-token']) fail('aplicar necesita --review-token de la vista previa');
  return {
    method: 'POST',
    route: 'va/census/' + year,
    body: {
      action: action === 'importar' ? 'preview' : 'apply',
      people: raw.people,
      source: { title: flags.title ?? path.basename(file), sha256: createHash('sha256').update(bytes).digest('hex') },
      ...(action === 'aplicar' ? { reviewToken: flags['review-token'] } : {}),
    },
  };
}
