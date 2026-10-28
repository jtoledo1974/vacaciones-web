/**
 * Vacaciones de antigüedad (VA): 1 day on reaching 20 years of seniority and one more
 * every 5 years, with no upper limit. Years count at 31/12 of the VA year, so whoever
 * turns 20 during 2027 already has the right in 2027 (and chooses in October 2026).
 */
export const VA_MIN_YEARS = 20;

export function vaYears(seniority: string | null | undefined, year: number): number | null {
  const from = /^(\d{4})-\d{2}-\d{2}$/.exec(seniority ?? '');
  return from ? year - Number(from[1]) : null;
}

export function vaDays(years: number | null): number {
  return years === null || years < VA_MIN_YEARS ? 0 : Math.floor((years - 15) / 5);
}

/** Calendar year in which a seniority date first gives the right to VA. */
export function vaFirstYear(seniority: string): number {
  return Number(seniority.slice(0, 4)) + VA_MIN_YEARS;
}
