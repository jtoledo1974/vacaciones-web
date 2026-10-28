/** Validate the explicit, complete sequence before any client/server writes.
 * Rows describe the grid; only selectionOrder describes how it was traversed.
 * A row's columns are its cycles in the order they were chosen, not their rounds:
 * a deferred turn ({round, code, deferred: true}) lets a later round take two or three.
 */
export function validateImportOrder(source) {
  const expected = new Map();
  const codes = new Set();
  for (const row of source.rows ?? []) {
    const code = normalize(row.code);
    codes.add(code);
    (row.dates ?? [])
      .filter((date) => date)
      .forEach((date, i) => {
        const key = JSON.stringify([code, date]);
        if (expected.has(key)) throw new Error('Selección repetida en la plantilla: ' + code + ' ' + date);
        expected.set(key, i + 1);
      });
  }
  validateJointGroups(source, codes);
  if (!expected.size) {
    if (source.selectionOrder?.length) throw new Error('El orden contiene selecciones que no están en la plantilla');
    return [];
  }
  if (
    !Array.isArray(source.selectionOrder) ||
    source.selectionOrder.filter((step) => step?.deferred !== true).length !== expected.size
  )
    throw new Error('Toda importación con selecciones exige selectionOrder explícito y completo (ronda, code, date)');
  const seen = new Set();
  const chosen = new Map();
  const deferredIn = new Set();
  let lastRound = 1;
  const steps = source.selectionOrder.map((step, i) => {
    const deferred = step?.deferred === true;
    if (
      !step ||
      !Number.isInteger(step.round) ||
      step.round < 1 ||
      typeof step.code !== 'string' ||
      (deferred ? step.date !== undefined : typeof step.date !== 'string')
    )
      throw new Error(`Paso ${i + 1}: indica ronda, code y date (o deferred: true sin date)`);
    const code = normalize(step.code);
    if (step.round < lastRound)
      throw new Error(
        `Paso ${i + 1}: las rondas deben avanzar en orden; no se importan todos los ciclos de una persona del tirón`,
      );
    lastRound = step.round;
    if (deferred) {
      const key = JSON.stringify([code, step.round]);
      if (!codes.has(code) || deferredIn.has(key))
        throw new Error(`Paso ${i + 1}: aplazamiento repetido o de alguien ajeno a la plantilla`);
      deferredIn.add(key);
      return { round: step.round, code, deferred: true };
    }
    const key = JSON.stringify([code, step.date]);
    const nth = (chosen.get(code) ?? 0) + 1;
    if (!expected.has(key) || seen.has(key) || expected.get(key) !== nth)
      throw new Error(`Paso ${i + 1}: selección duplicada, ajena o fuera del orden de columnas de su fila`);
    // A row can never be ahead of its turns: its n-th cycle needs at least n rounds.
    if (step.round < nth || deferredIn.has(JSON.stringify([code, step.round])))
      throw new Error(`Paso ${i + 1}: ${code} no puede elegir su ciclo ${nth} en la ronda ${step.round}`);
    seen.add(key);
    chosen.set(code, nth);
    return { round: step.round, code, date: step.date };
  });
  if (seen.size !== expected.size)
    throw new Error('Toda importación con selecciones exige selectionOrder explícito y completo (ronda, code, date)');
  return steps;
}

const normalize = (code) =>
  String(code ?? '')
    .trim()
    .toUpperCase();

/** Joint turns, compared by normalized nick: permanent `jointGroups` and one-round `jointTurns`. */
export function importJoints(source) {
  return {
    groups: (source.jointGroups ?? []).map((g) => g.map(normalize)),
    turns: (source.jointTurns ?? []).map((t) => ({ round: t.round, codes: t.codes.map(normalize) })),
  };
}

function validateJointGroups(source, codes) {
  const invalid = (g) =>
    !Array.isArray(g) || g.length < 2 || g.length > 3 || g.some((code) => typeof code !== 'string');
  if (source.jointGroups !== undefined && (!Array.isArray(source.jointGroups) || source.jointGroups.some(invalid)))
    throw new Error('jointGroups: cada turno conjunto agrupa a 2 o 3 personas distintas de la plantilla');
  if (
    source.jointTurns !== undefined &&
    (!Array.isArray(source.jointTurns) ||
      source.jointTurns.some((t) => !t || !Number.isInteger(t.round) || t.round < 1 || invalid(t.codes)))
  )
    throw new Error('jointTurns: cada turno conjunto indica su ronda y agrupa a 2 o 3 personas de la plantilla');
  const { groups, turns } = importJoints(source);
  const permanent = new Set();
  for (const g of groups)
    for (const code of g) {
      if (!codes.has(code) || permanent.has(code))
        throw new Error('jointGroups: cada turno conjunto agrupa a 2 o 3 personas distintas de la plantilla');
      permanent.add(code);
    }
  const perRound = new Map();
  for (const t of turns) {
    const used = perRound.get(t.round) ?? new Set();
    for (const code of t.codes) {
      if (!codes.has(code) || used.has(code) || permanent.has(code))
        throw new Error(`jointTurns: ${code} aparece en más de un turno conjunto de la ronda ${t.round}`);
      used.add(code);
    }
    perRound.set(t.round, used);
  }
}
