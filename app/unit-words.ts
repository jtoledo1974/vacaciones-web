import type { PolicyPresentation } from '../domain/occupancy';

/** How the campaign's policy calls what members choose: cycles by default, days in VA. */
export function unitWords(presentation?: Pick<PolicyPresentation, 'units'> | null) {
  return presentation?.units ?? { one: 'ciclo', many: 'ciclos' };
}
/** «1 ciclo», «3 días». */
export const unitCount = (units: { one: string; many: string }, n: number) =>
  n === 1 ? '1 ' + units.one : n + ' ' + units.many;
/** The policy's units are single days (VA), whether or not any day has places yet. */
export const singleDays = (presentation?: Pick<PolicyPresentation, 'units'> | null) => !!presentation?.units;
