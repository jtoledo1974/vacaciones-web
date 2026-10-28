import { officialHolidays } from './official-holidays.ts';
import type { Config, Holiday } from './calendar';
import reference from '../tests/excel-reference.json' with { type: 'json' };
const fixed = (label: string, month: number, day: number, score: number, nextYear = false): Holiday => ({
  label,
  month,
  day,
  score,
  shiftSunday: true,
  saturdayBase: true,
  nextYear,
});
const holidays: Holiday[] = [
  fixed('Año Nuevo', 1, 1, 10),
  fixed('Reyes', 1, 6, 9),
  fixed('Día de Andalucía', 2, 28, 8),
  { label: 'Lunes Santo', offset: -6, score: 9 },
  { label: 'Domingo de Resurrección', offset: 0, score: 9 },
  { label: 'Sábado previo a Feria', offset: 13, score: 5 },
  { label: 'Domingo previo a Feria', offset: 14, score: 5 },
  { label: 'Lunes de Feria', offset: 15, score: 8 },
  { label: 'Domingo de Feria', offset: 21, score: 8 },
  fixed('Día del Trabajo', 5, 1, 8),
  { label: 'Miércoles de Feria (regla original +18)', offset: 18, score: 8, saturdayBase: true },
  { label: 'Corpus', offset: 60, score: 8, shiftSunday: true, corpus: true },
  fixed('Asunción', 8, 15, 10),
  fixed('Día del Pilar', 10, 12, 8),
  fixed('Todos los Santos', 11, 1, 8),
  fixed('Constitución', 12, 6, 8),
  fixed('Inmaculada', 12, 8, 8),
  fixed('Año Nuevo siguiente', 1, 1, 10, true),
  fixed('Reyes siguiente', 1, 6, 9, true),
];
export function defaultConfig(y: number): Config {
  return {
    cycleLength: 8,
    cyclesPerPerson: 6,
    summerPerPerson: 2,
    summerStart: `${y}-06-01`,
    summerEnd: `${y}-09-30`,
    correturnos: `${y}-01-09`,
    excludeLast: true,
    excludePenultimate: false,
    min: [1, 1, 1],
    base: [2, 2, 2],
    grace: [1, 0, 1],
    commonGrace: false,
    commonConvention: true,
    conventionJanuary: 0,
    weights: [1, 1, 1, 1, 1, 1],
    relation: { minimum: 1, base: 2, maximum: 3, graceJanuary: 0, graceOctober: 0 },
    baseScores: reference.base
      .filter((s) => s.date >= '2026-01-01')
      .map((s) => ({
        month: Number(s.date.slice(5, 7)),
        day: Number(s.date.slice(8)),
        score: s.score,
        nextYear: s.date.startsWith('2027'),
      })),
    specialCycles: [],
    rotation: reference.rotation,
    holidays: structuredClone(holidays),
    calendarHolidays: officialHolidays(y),
  };
}
export function copyConfig(c: Config, from: number, to: number): Config {
  const n = structuredClone(c);
  delete n.previousScores;
  delete n.previousScoresSource;
  // RRHH exceptions are dated campaign-specific permissions, never inherited.
  delete n.specialQuotas;
  delete n.individualEntitlements;
  // Labour holidays cannot be copied between years: local dates and transfers change.
  n.calendarHolidays = officialHolidays(to);
  for (const k of ['summerStart', 'summerEnd', 'correturnos'] as const) n[k] = String(to) + n[k].slice(4);
  n.specialCycles = n.specialCycles.map((d) => String(Number(d.slice(0, 4)) - from + to) + d.slice(4));
  return n;
}
