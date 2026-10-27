/**
 * Mapping of a team's final awards onto RRHH's yearly workbook (one sheet per
 * team). Pure: the workbook is read and patched in server/hr-xlsx.ts.
 *
 * Each sheet lists one row per cycle (B period, C start, D end) and four "CTA"
 * columns E:H for the people awarded it; J holds the team roster with RRHH's
 * exact spelling, which is what must be written.
 */

/** Columns where awarded people are written, in order of choice. */
export const HR_COLUMNS = ['E', 'F', 'G', 'H'] as const;

export type HrSheet = {
  team: string;
  /** One per cycle, in sheet order. Dates are ISO. */
  rows: { row: number; start: string; end: string }[];
  /** Column J, verbatim. */
  roster: string[];
};
export type HrMember = { id: string; code: string; label?: string | null };
export type HrAward = { member_id: string; cycle_date: string };
export type HrCycle = { date: string; end: string };
export type HrCell = { ref: string; value: string };

export class HrExportError extends Error {
  constructor(
    message: string,
    public details: string[] = [],
  ) {
    super(details.length ? message + ': ' + details.join(', ') : message);
  }
}

/** Accent-, case- and punctuation-insensitive tokens of a name, sorted. */
function tokens(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .split(/[^A-Z0-9Ñ]+/)
    .filter(Boolean)
    .sort()
    .join(' ');
}

/**
 * Proposed RRHH name for each member: the roster entry with the same words as
 * the member's label or code, when exactly one matches. Admins confirm it.
 */
export function suggestHrNames(members: readonly HrMember[], roster: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of members) {
    for (const source of [m.label, m.code]) {
      const key = source ? tokens(source) : '';
      const hits = key ? roster.filter((r) => tokens(r) === key) : [];
      if (hits.length === 1) {
        out[m.id] = hits[0];
        break;
      }
    }
  }
  return out;
}

/** The person as the web shows them, for error messages. */
const shown = (m: HrMember) => (m.label ? `${m.label} (${m.code})` : m.code);

/**
 * Cells to write on a team sheet: every row's E:H, awarded people in the order
 * given (the order they chose), blanks for the rest so a stale value never stays.
 */
export function hrTeamCells(input: {
  sheet: HrSheet;
  cycles: readonly HrCycle[];
  members: readonly HrMember[];
  /** Already in order of choice. */
  awards: readonly HrAward[];
  /** member id → RRHH name (column J). */
  names: Readonly<Record<string, string>>;
}): HrCell[] {
  const { sheet, cycles, members, awards, names } = input;
  if (sheet.rows.length !== cycles.length)
    throw new HrExportError(`La hoja ${sheet.team} tiene ${sheet.rows.length} ciclos y la campaña ${cycles.length}`);
  const mismatched = sheet.rows.flatMap((r, i) =>
    r.start === cycles[i].date && r.end === cycles[i].end
      ? []
      : [`fila ${r.row} (${r.start}–${r.end} frente a ${cycles[i].date}–${cycles[i].end})`],
  );
  if (mismatched.length) throw new HrExportError(`Las fechas de la hoja ${sheet.team} no cuadran`, mismatched);

  const byId = new Map(members.map((m) => [m.id, m]));
  const awarded = [...new Set(awards.map((a) => a.member_id))].map((id) => byId.get(id) ?? { id, code: id });
  const roster = new Set(sheet.roster);
  const missing = awarded.filter((m) => !names[m.id] || !roster.has(names[m.id])).map(shown);
  if (missing.length) throw new HrExportError(`Personas sin nombre de RRHH en la hoja ${sheet.team}`, missing);
  const owners = new Map<string, HrMember[]>();
  for (const m of awarded) owners.set(names[m.id], [...(owners.get(names[m.id]) ?? []), m]);
  const shared = [...owners].filter(([, ms]) => ms.length > 1).map(([n, ms]) => `${n}: ${ms.map(shown).join(' y ')}`);
  if (shared.length) throw new HrExportError('Un mismo nombre de RRHH está asignado a varias personas', shared);

  const rowOf = new Map(cycles.map((c, i) => [c.date, sheet.rows[i].row]));
  const byRow = new Map<number, string[]>();
  for (const a of awards) {
    const row = rowOf.get(a.cycle_date);
    if (row === undefined) throw new HrExportError('Ciclo adjudicado fuera del calendario', [a.cycle_date]);
    byRow.set(row, [...(byRow.get(row) ?? []), names[a.member_id]]);
  }
  const full = [...byRow].filter(([, n]) => n.length > HR_COLUMNS.length).map(([row]) => `fila ${row}`);
  if (full.length) throw new HrExportError(`Más de ${HR_COLUMNS.length} personas en un ciclo`, full);
  return sheet.rows.flatMap(({ row }) =>
    HR_COLUMNS.map((col, i) => ({ ref: col + row, value: byRow.get(row)?.[i] ?? '' })),
  );
}
