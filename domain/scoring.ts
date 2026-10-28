import type { Config, Holiday } from './calendar.ts';
import { policyFor } from './policy.ts';

export type AnnualScoring = {
  version: string;
  baseScores: readonly Config['baseScores'][number][];
  holidays: readonly Holiday[];
  weights: readonly number[];
};
/** Annual implementations are registered exclusively at the policy boundary. */
const annualScoring = (year: number) => policyFor(year).scoring;

/** Registered campaign rules override legacy stored formulas, including existing
 * campaigns. Other years retain their own saved configuration unchanged.
 * Return a copy so callers cannot mutate the annual authority.
 */
export function hasAnnualScoring(year: number): boolean {
  return annualScoring(year) !== undefined;
}

export function scoringHolidays(year: number, legacy: readonly Holiday[]): Holiday[] {
  return structuredClone([...(annualScoring(year)?.holidays ?? legacy)]);
}

export function scoringBaseScores(year: number, legacy: Config['baseScores']): Config['baseScores'] {
  return structuredClone([...(annualScoring(year)?.baseScores ?? legacy)]);
}

export function scoringWeights(year: number, legacy: readonly number[]): number[] {
  return [...(annualScoring(year)?.weights ?? legacy)];
}

export function scoringVersion(year: number): string {
  return annualScoring(year)?.version ?? 'legacy-config';
}

/** Effective values for display/export and new reviews; never mutate saved parameters. */
export function effectiveScoringConfig(year: number, config: Config): Config {
  return hasAnnualScoring(year)
    ? {
        ...config,
        baseScores: scoringBaseScores(year, config.baseScores),
        holidays: scoringHolidays(year, config.holidays),
        weights: scoringWeights(year, config.weights),
      }
    : config;
}

/** Explicit configuration writes must not save edits the annual authority ignores. */
export function assertAnnualScoringConfig(year: number, config: Config): void {
  if (!hasAnnualScoring(year)) return;
  const official = effectiveScoringConfig(year, config);
  const stable = (rules: object[]) =>
    JSON.stringify(
      rules.map((rule) =>
        Object.entries(rule)
          .filter(([, value]) => value !== undefined)
          .sort(([a], [b]) => a.localeCompare(b)),
      ),
    );
  if (
    stable(config.baseScores) !== stable(official.baseScores) ||
    stable(config.holidays) !== stable(official.holidays) ||
    JSON.stringify(config.weights) !== JSON.stringify(official.weights)
  )
    throw new Error(
      `El baremo oficial ${scoringVersion(year)} es de solo lectura. Recarga los parámetros vigentes; sus tramos, festivos y pesos se definen en código.`,
    );
}
