import type { Config, Holiday } from './calendar.ts';

/** Annual authority: _FINAL2 BRAVO 2027 Perpetuo V22.0.0.D1.xlsx.
 * Baremo!AO100:AR496: date, base, holiday, MAX(base, holiday).
 * Holidays: corrected dates AJ8:AJ30 and fixed values AL8:AL30.
 * No legacy Saturday, Sunday-transfer or Corpus formulas are applied again.
 * Holy Week and Feria endpoints delimit complete scoring intervals.
 */
export const SCORING_VERSION_2027 = 'lecs-2027-final2-v22.0.0.d1-2';
/** Vac!D5:I5: the six official weights are all one. No authorised exceptions. */
export const SCORING_WEIGHTS_2027 = [1, 1, 1, 1, 1, 1] as const;
export const BASE_SCORES_2027: readonly Config['baseScores'][number][] = [
  { month: 1, day: 1, score: 10 },
  { month: 1, day: 2, score: 9 },
  { month: 1, day: 7, score: 3 },
  { month: 3, day: 1, score: 4 },
  { month: 4, day: 16, score: 5 },
  { month: 6, day: 1, score: 7 },
  { month: 6, day: 16, score: 9 },
  { month: 7, day: 1, score: 10 },
  { month: 9, day: 1, score: 9 },
  { month: 9, day: 16, score: 7 },
  { month: 10, day: 1, score: 5 },
  { month: 11, day: 16, score: 4 },
  { month: 12, day: 24, score: 10 },
  { month: 1, day: 2, score: 9, nextYear: true },
  { month: 1, day: 7, score: 3, nextYear: true },
];

export const SCORING_2027: readonly Holiday[] = [
  { label: 'Año Nuevo', month: 1, day: 1, score: 10 },
  { label: 'Reyes', month: 1, day: 6, score: 9 },
  { label: 'Día de Andalucía', month: 3, day: 1, score: 8 },
  { label: 'Lunes Santo', month: 3, day: 22, score: 9 },
  { label: 'Domingo de Resurrección', month: 3, day: 28, score: 9 },
  { label: 'Sábado previo a Feria', month: 4, day: 10, score: 5 },
  { label: 'Domingo previo a Feria', month: 4, day: 11, score: 5 },
  { label: 'Lunes de Feria', month: 4, day: 12, score: 8 },
  { label: 'Domingo de Feria', month: 4, day: 18, score: 8 },
  { label: 'Día del Trabajo', month: 5, day: 1, score: 8 },
  { label: 'Miércoles de Feria', month: 4, day: 14, score: 8 },
  { label: 'Corpus', month: 5, day: 27, score: 8 },
  { label: 'Asunción', month: 8, day: 16, score: 10 },
  { label: 'Día del Pilar', month: 10, day: 12, score: 8 },
  { label: 'Todos los Santos', month: 11, day: 1, score: 8 },
  { label: 'Constitución', month: 12, day: 6, score: 8 },
  { label: 'Inmaculada', month: 12, day: 8, score: 8 },
  { label: 'Año Nuevo siguiente', month: 1, day: 1, score: 10, nextYear: true },
  { label: 'Reyes siguiente', month: 1, day: 6, score: 9, nextYear: true },
];
