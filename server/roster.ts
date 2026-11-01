import { serial, type Config } from '../domain/calendar.ts';
import { unitsOf } from '../domain/policy.ts';
import type { Statement } from './repository.ts';
export type RosterRow = { memberId?: string; code: string; label: string; seniority: string; dates?: string[] };
export function validateRoster(rows: any, year: number, team: string, config: Config): RosterRow[] {
  if (!Array.isArray(rows) || rows.length > 100)
    throw new Error('La plantilla debe contener entre 0 y 100 controladores');
  const codes = new Set<string>(),
    members = new Set<string>(),
    dates = new Set(unitsOf({ year, team, config }).map((c) => c.date));
  return rows.map((row, i) => {
    const code = String(row.code ?? '')
        .trim()
        .toUpperCase(),
      label = String(row.label ?? '').trim(),
      seniority = String(row.seniority ?? '').trim();
    if (!/^[\p{L}\p{N} _.-]{1,24}$/u.test(code)) throw new Error(`Fila ${i + 1}: identificador no válido`);
    if (label.length > 120 || /[\r\n\t]/.test(label)) throw new Error(`Fila ${i + 1}: nombre no válido`);
    if (seniority) {
      serial(seniority);
      if (seniority > `${year}-12-31`) throw new Error(`Fila ${i + 1}: antigüedad posterior al ejercicio`);
    }
    if (codes.has(code)) throw new Error(`Identificador repetido: ${code}`);
    codes.add(code);
    if (row.memberId) {
      if (typeof row.memberId !== 'string' || members.has(row.memberId)) throw new Error('Controlador repetido');
      members.add(row.memberId);
    }
    const selections = row.dates ?? [];
    if (
      !Array.isArray(selections) ||
      selections.length > 6 ||
      selections.some((d) => typeof d !== 'string' || (d && !dates.has(d)))
    )
      throw new Error(`Fila ${i + 1}: fecha de ciclo no válida`);
    if (new Set(selections.filter(Boolean)).size !== selections.filter(Boolean).length)
      throw new Error(`Fila ${i + 1}: ciclo repetido`);
    return { memberId: row.memberId, code, label, seniority, dates: selections };
  });
}
export function rowStatements(
  cid: string,
  team: string,
  row: RosterRow,
  position: number,
  personId: string,
  memberId: string,
): Statement[] {
  return [
    {
      sql: 'INSERT INTO people(id,team_id,code,label,seniority,position,active,version) VALUES(?,?,?,?,?,?,1,1)',
      args: [personId, team, personId, row.label, row.seniority, position],
    },
    {
      sql: 'INSERT INTO campaign_members(id,campaign_id,person_id,code,label,seniority,position,version) VALUES(?,?,?,?,?,?,?,1)',
      args: [memberId, cid, personId, row.code, row.label, row.seniority, position],
    },
  ];
}
