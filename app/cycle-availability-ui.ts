import type { AvailabilitySlot, AvailabilityImpact, PolicyPresentation } from '../domain/occupancy';

export { cycleAvailability, cycleOccupancyLabel } from '../domain/cycle-availability.ts';

/** Explain a proven block without promoting a search timeout to an illegality. */
export function slotExplanation(slot: AvailabilitySlot | undefined): string {
  if (!slot) return 'Plaza sin diagnóstico';
  if (slot.status === 'occupied') return 'Plaza adjudicada';
  if (slot.status === 'available') return 'Adjudicación globalmente posible; la persona concreta se valida al elegir';
  if (slot.status === 'indeterminate')
    return (
      'Viabilidad indeterminada: ' +
      (slot.reasons.map((r) => r.message).join('; ') || 'no se ha demostrado el resultado')
    );
  return slot.reasons.map((r) => r.message).join('; ') || 'Bloqueo global demostrado';
}

const shortDate = (date: string) =>
  new Date(date + 'T12:00:00').toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });

/** A presentation template filled with an impact event's facts. */
function fill(
  template: string,
  presentation: PolicyPresentation,
  event: AvailabilityImpact['events'][number],
  cycles: string[],
) {
  const values: Record<string, string> = {
    period: (event.period !== undefined ? presentation.periodNames[event.period] : undefined) ?? 'periodo',
    ratio: event.actual !== undefined && event.limit !== undefined ? ' (' + event.actual + '/' + event.limit + ')' : '',
    count: String(cycles.length),
    cycles: cycles.map(shortDate).join(', '),
  };
  return template.replace(/\{(\w+)\}/g, (all, key) => values[key] ?? all);
}

/**
 * What a decision changed beyond its own cycle, for people reviewing it.
 * The chosen cycle losing a place, a person exhausting their own rights and
 * unproved bounds are not consequences worth showing; period-wide events are
 * highlighted and proven losses in other cycles are listed as details.
 */
export function summarizeImpact(
  impact: AvailabilityImpact,
  presentation: PolicyPresentation,
): { highlights: string[]; details: string[] } {
  const highlights: string[] = [],
    covered = new Set<string>();
  // Fixed per-cycle limits are always present; they are never what a decision caused.
  const caused = (c: AvailabilityImpact['changes'][number]) =>
    c.reasons.filter((r) => !presentation.staticReasons.includes(r.code));
  const ownRightsOnly = new Set(
    impact.changes
      .filter((c) => {
        const r = caused(c);
        return r.length > 0 && r.every((x) => x.code === presentation.ownRightsReason);
      })
      .map((c) => c.cycle),
  );
  for (const event of impact.events) {
    const text = presentation.impactEvents[event.code];
    if (!text?.highlight) continue;
    const cycles = text.cycles === 'exceptOwnRights' ? event.cycles.filter((c) => !ownRightsOnly.has(c)) : event.cycles;
    if (text.cycles !== 'exceptOwnRights' || cycles.length)
      highlights.push(fill(text.highlight, presentation, event, cycles));
    event.cycles.forEach((c) => covered.add(c));
  }
  const details: string[] = [];
  for (const change of impact.changes) {
    const old = change.before.additional,
      now = change.after.additional;
    if (change.kind !== 'globalConstraint' || covered.has(change.cycle) || old === null || now === null || now >= old)
      continue;
    if (ownRightsOnly.has(change.cycle)) continue;
    details.push(shortDate(change.cycle) + ': ' + old + ' → ' + now + ' plaza(s) adicionales.');
  }
  return { highlights: [...new Set(highlights)], details };
}

/** Only describe proven losses: an interval is explicitly uncertain. */
export function describeImpact(impact: AvailabilityImpact, presentation: PolicyPresentation): string[] {
  const lines: string[] = [];
  for (const change of impact.changes) {
    const old = change.before.additional,
      now = change.after.additional;
    const heading = change.kind === 'directOccupancy' ? 'Adjudicación directa' : 'Restricción global';
    if (old !== null && now !== null) {
      const lost = old - now;
      if (lost > 0)
        lines.push(
          heading + ': ' + change.cycle + ' reduce ' + lost + ' plaza(s) adicionales (' + old + ' → ' + now + ').',
        );
      else if (lost < 0)
        lines.push(
          heading + ': ' + change.cycle + ' aumenta ' + -lost + ' plaza(s) adicionales (' + old + ' → ' + now + ').',
        );
    } else {
      lines.push(
        heading +
          ': ' +
          change.cycle +
          ' cambia con cotas no concluyentes (' +
          change.before.lower +
          '–' +
          change.before.upper +
          ' → ' +
          change.after.lower +
          '–' +
          change.after.upper +
          ').',
      );
    }
  }
  for (const event of impact.events) {
    const text = presentation.impactEvents[event.code],
      line = (event.period !== undefined ? text?.lineByPeriod?.[event.period] : undefined) ?? text?.line;
    if (line) lines.push(fill(line, presentation, event, event.cycles));
  }
  return [...new Set(lines)];
}
