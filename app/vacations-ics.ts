import { iso, serial } from '../domain/calendar.ts';

/** Data already supplied to the signed-in controller; no external calendar API is required. */
export type PersonalCalendarSource = {
  campaign: { year: number; team_id: string; status: string; scope_key: string; data_kind?: string };
  election?: { myMemberId?: string | null; policyPresentation?: { units?: { one: string; many: string } } | null };
  preview?: unknown;
  awards: { member_id: string; cycle_date: string; simulated?: boolean }[];
  result: { cycles: { date: string; end: string }[] };
};

const UID_DOMAIN = 'vacaciones.lazaro.es';

export type PersonalCalendarExport = { filename: string; content: string; count: number };

/** Fold iCalendar content lines at 75 UTF-8 octets, including continuation whitespace. */
export function foldLine(line: string): string {
  const encoder = new TextEncoder();
  let output = '';
  let octets = 0;
  for (const character of line) {
    const bytes = encoder.encode(character).length;
    if (octets + bytes > 75) {
      output += '\r\n ';
      octets = 1;
    }
    output += character;
    octets += bytes;
  }
  return output;
}

/**
 * Export the linked controller's final allocations only. The existing calendar engine
 * owns both ends of every cycle (including the exceptional leap-year correturnos day).
 * A closed campaign may legitimately award fewer than six cycles to some controllers.
 */
export function personalVacationCalendar(
  data: PersonalCalendarSource,
  generatedAt: Date = new Date(),
): PersonalCalendarExport | null {
  const memberId = data.election?.myMemberId;
  if (
    !memberId ||
    data.preview ||
    data.campaign.scope_key !== 'live' ||
    data.campaign.status !== 'closed' ||
    data.campaign.data_kind === 'demo'
  )
    return null;

  const ownAwards = data.awards.filter((award) => award.member_id === memberId && !award.simulated);
  const dates = Array.from(new Set(ownAwards.map((award) => award.cycle_date))).sort();
  if (!dates.length) return null;

  const cycles = new Map(data.result.cycles.map((cycle) => [cycle.date, cycle]));
  // VA (ADR 0002) awards single days.
  const va = data.campaign.team_id === 'va',
    name = va ? 'Vacaciones de antigüedad' : 'Vacaciones';
  const stamp = generatedAt
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Vacaciones LECS//Calendario individual//ES',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:' + name + ' LECS ' + data.campaign.year,
  ];

  try {
    for (const date of dates) {
      const cycle = cycles.get(date);
      if (!cycle) {
        console.warn(`ICS: el ciclo ${date} adjudicado no figura en el resultado; no se genera el calendario.`);
        return null;
      }
      const first = serial(cycle.date);
      const last = serial(cycle.end);
      // Normally eight days, or nine only for the leap-year correturnos boundary; one in VA.
      if (va ? last !== first : last - first < 7 || last - first > 8) {
        console.warn(`ICS: duración no válida en el ciclo ${date}; no se genera el calendario.`);
        return null;
      }
      const uidBase = `vacaciones-${data.campaign.year}-${data.campaign.team_id}`;
      const memberToken = encodeURIComponent(memberId);
      const dateToken = date.replaceAll('-', '');
      const uid = `${uidBase}-${memberToken}-${dateToken}@${UID_DOMAIN}`;
      lines.push(
        'BEGIN:VEVENT',
        'UID:' + uid,
        'DTSTAMP:' + stamp,
        'DTSTART;VALUE=DATE:' + cycle.date.replaceAll('-', ''),
        // RFC 5545 defines DTEND as exclusive; cycle.end is inclusive.
        'DTEND;VALUE=DATE:' + iso(last + 1).replaceAll('-', ''),
        'SUMMARY:' + name,
        'STATUS:CONFIRMED',
        'TRANSP:OPAQUE',
        'END:VEVENT',
      );
    }
  } catch (error) {
    // Never offer a partial or corrupt calendar.
    console.warn('ICS: fecha de ciclo no válida; no se genera el calendario.', error);
    return null;
  }
  lines.push('END:VCALENDAR');
  return {
    filename: va
      ? 'vacaciones-antiguedad-' + data.campaign.year + '.ics'
      : 'vacaciones-' + data.campaign.year + '-equipo-' + data.campaign.team_id + '.ics',
    content: lines.map(foldLine).join('\r\n') + '\r\n',
    count: dates.length,
  };
}
