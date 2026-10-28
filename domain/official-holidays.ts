/**
 * Calendario laboral de Sevilla para 2027, separado del baremo de puntuación.
 * Andalucía: Decreto 84/2026 (BOJA 84, 05/05/2026).
 * Locales: acuerdo del Pleno de Sevilla del 18/06/2026.
 *
 * No se extrapolan festivos a otros años: las fiestas trasladadas y las
 * decisiones municipales requieren comprobación oficial por ejercicio.
 */
export type CalendarHoliday = { date: string; label: string; local?: boolean };

export const OFFICIAL_SEVILLE_HOLIDAYS_2027: CalendarHoliday[] = [
  { date: '2027-01-01', label: 'Año Nuevo' },
  { date: '2027-01-06', label: 'Epifanía' },
  { date: '2027-03-01', label: 'Día de Andalucía' },
  { date: '2027-03-25', label: 'Jueves Santo' },
  { date: '2027-03-26', label: 'Viernes Santo' },
  { date: '2027-04-14', label: 'Feria de Sevilla', local: true },
  { date: '2027-05-01', label: 'Día del Trabajo' },
  { date: '2027-05-27', label: 'Corpus Christi', local: true },
  { date: '2027-08-16', label: 'Asunción' },
  { date: '2027-10-12', label: 'Fiesta Nacional' },
  { date: '2027-11-01', label: 'Todos los Santos' },
  { date: '2027-12-06', label: 'Constitución' },
  { date: '2027-12-08', label: 'Inmaculada' },
  { date: '2027-12-25', label: 'Navidad' },
];

export function officialHolidays(year: number): CalendarHoliday[] {
  return year === 2027 ? structuredClone(OFFICIAL_SEVILLE_HOLIDAYS_2027) : [];
}

/**
 * A stored list is authoritative for its own campaign; older 2027 campaigns
 * without this property inherit the fixed, published 2027 calendar.
 */
export function calendarHolidaysForYear(
  year: number,
  config: { calendarHolidays?: CalendarHoliday[] },
): CalendarHoliday[] {
  return config.calendarHolidays ?? officialHolidays(year);
}
