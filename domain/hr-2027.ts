/**
 * 2027 LECS calendar metadata, transcribed from RRHH workbook 2027_LECS_Vac .xlsm.
 * SHA-256: de5755fdaedbffb32889667750afa81e94b70dc28a37ad79eb8177ac24539e75
 *
 * No employee data or macros from the source workbook are stored here.
 * "Resto" means outside summer even when the start date is in September.
 */
export const HR_2027_SOURCE_SHA256 = 'de5755fdaedbffb32889667750afa81e94b70dc28a37ad79eb8177ac24539e75';

export const HR_2027: Record<
  string,
  {
    count: number;
    first: string;
    summerFirst: string;
    summerLast: string;
    red: readonly string[];
  }
> = {
  A: {
    count: 45,
    first: '2027-01-08',
    summerFirst: '2027-06-01',
    summerLast: '2027-09-21',
    red: ['2027-03-21', '2027-04-14', '2027-12-18'],
  },
  B: {
    count: 46,
    first: '2027-01-01',
    summerFirst: '2027-06-02',
    summerLast: '2027-09-22',
    red: ['2027-03-22', '2027-04-07', '2027-12-27'],
  },
  C: {
    count: 46,
    first: '2027-01-02',
    summerFirst: '2027-06-03',
    summerLast: '2027-09-23',
    red: ['2027-03-23', '2027-04-16', '2027-12-28'],
  },
  D: {
    count: 46,
    first: '2027-01-03',
    summerFirst: '2027-06-04',
    summerLast: '2027-09-16',
    red: ['2027-03-24', '2027-04-09', '2027-12-21'],
  },
  E: {
    count: 46,
    first: '2027-01-04',
    summerFirst: '2027-06-05',
    summerLast: '2027-09-17',
    red: ['2027-03-25', '2027-04-10', '2027-12-22'],
  },
  F: {
    count: 46,
    first: '2027-01-05',
    summerFirst: '2027-06-06',
    summerLast: '2027-09-18',
    red: ['2027-03-18', '2027-04-11', '2027-12-31'],
  },
  G: {
    count: 45,
    first: '2027-01-06',
    summerFirst: '2027-06-07',
    summerLast: '2027-09-19',
    red: ['2027-03-19', '2027-04-12', '2027-12-24'],
  },
  H: {
    count: 45,
    first: '2027-01-07',
    summerFirst: '2027-06-08',
    summerLast: '2027-09-20',
    red: ['2027-03-20', '2027-04-13', '2027-12-25'],
  },
};

export type HR2027Period = 0 | 1 | 2;

/** Explicit RRHH classification: 0=preverano, 1=verano, 2=postverano. */
export function hr2027Period(team: string, date: string): HR2027Period {
  const rules = HR_2027[team];
  if (!rules) throw new Error('Equipo de RRHH desconocido');
  return date < rules.summerFirst ? 0 : date <= rules.summerLast ? 1 : 2;
}

export function hr2027FourthExcluded(team: string, date: string): boolean {
  return HR_2027[team]?.red.includes(date) ?? false;
}
