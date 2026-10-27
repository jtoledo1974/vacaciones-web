import type { AvailabilitySnapshot, CycleAvailability } from './occupancy.ts';

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
