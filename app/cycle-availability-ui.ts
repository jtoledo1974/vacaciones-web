import type {
  AvailabilitySnapshot,
  CycleAvailability,
  AvailabilitySlot,
  AvailabilityImpact,
  PolicyPresentation,
} from '../domain/occupancy';

/** Occupied / viable final capacity; uncertain capacity stays explicit. `ruled`: the campaign has an occupancy engine. */
export function cycleOccupancyLabel(
  cycle: { date: string; occupied: number; max: number },
  snapshot: AvailabilitySnapshot | null | undefined,
  ruled: boolean,
): string {
  if (!ruled) return cycle.occupied + '/' + cycle.max;
  const data = snapshot?.cycles?.[cycle.date];
  if (!data || data.status === 'invalid') return cycle.occupied + '/?';
  if (data.status === 'exact' && data.additional !== null)
    return cycle.occupied + '/' + (cycle.occupied + data.additional);
  const lower = cycle.occupied + data.provenAdditional,
    upper = cycle.occupied + data.possibleAdditionalUpperBound;
  return cycle.occupied + '/' + (lower === upper ? String(lower) : lower + '–' + upper);
}

/** The backend, not the visual maximum, determines legal global capacity. */
export function cycleAvailability(
  cycle: { date: string; occupied: number; max: number },
  snapshot: AvailabilitySnapshot | null | undefined,
  ruled: boolean,
) {
  const live = ruled;
  const data = live ? snapshot?.cycles?.[cycle.date] : undefined;
  const local = Math.max(0, cycle.max - cycle.occupied);
  if (!live)
    return {
      data: null as CycleAvailability | null,
      label: String(local),
      description: local + ' plazas libres',
      className: 'vac2-free-' + Math.min(4, local),
    };
  if (!data)
    return {
      data: null as CycleAvailability | null,
      label: '?',
      description: 'Disponibilidad global aún no calculada',
      className: 'vac2-unknown',
    };
  if (data.status === 'invalid')
    return {
      data,
      label: '—',
      description: 'El reparto no admite una completación válida; requiere revisión',
      className: 'vac2-unknown',
    };
  // Nothing can be added whatever the search proves: that is full, not «por confirmar».
  if (data.status === 'indeterminate' && data.possibleAdditionalUpperBound === 0)
    return { data, label: '0', description: 'Sin plazas adicionales posibles', className: 'vac2-free-0' };
  if (data.status === 'indeterminate') {
    const range = data.provenAdditional + '–' + data.possibleAdditionalUpperBound;
    return {
      data,
      label: '?',
      description: 'Disponibilidad sin determinar (' + range + ' plazas adicionales posibles)',
      className: 'vac2-unknown',
    };
  }
  return {
    data,
    label: String(data.additional),
    description:
      data.additional + ' plazas adicionales globalmente viables (no garantiza cualquier combinación de personas)',
    className: 'vac2-free-' + data.additional,
  };
}

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
