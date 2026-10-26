import { HR_2027, hr2027Period } from './hr-2027.ts';

/**
 * Calendar facts transcribed from RRHH workbooks, per year and team.
 * Kept free of policy imports so the calendar can depend on it.
 */
export type HRCalendar = { count: number; period(date: string): 0 | 1 | 2 };

const WORKBOOKS: Record<number, typeof HR_2027> = { 2027: HR_2027 };
const PERIODS: Record<number, (team: string, date: string) => 0 | 1 | 2> = { 2027: hr2027Period };

/** The RRHH calendar for a team, or null when the year uses configured periods. */
export function hrCalendar(year: number, team: string): HRCalendar | null {
  const rules = WORKBOOKS[year]?.[team];
  return rules ? { count: rules.count, period: (date) => PERIODS[year](team, date) } : null;
}

/** Whether RRHH may grant named controllers a different number of cycles this year. */
export function grantsIndividualEntitlements(year: number): boolean {
  return year in WORKBOOKS;
}
