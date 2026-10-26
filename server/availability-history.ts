import type { Repository } from './repository.ts';
import type { AvailabilitySnapshot, CompactAvailabilitySnapshot } from '../domain/occupancy.ts';

export type HistoricalAvailability = {
  restored: boolean;
  recordedAvailability?: AvailabilitySnapshot | CompactAvailabilitySnapshot;
};

/**
 * Read-only recovery of a previously committed allocation's certified
 * availability. The campaign-version CAS ensures no intervening mutation
 * has changed the roster or cycle occupancy.
 *
 * Never run the feasibility solver in an undo, redo or reconstruction-back
 * read. Old audit entries without certified snapshots remain provisional.
 */
export async function historicalAvailability(
  repo: Repository,
  cid: string,
  version: number,
): Promise<HistoricalAvailability> {
  const rows = await repo.all('SELECT action,after_json FROM audit WHERE campaign_id=? ORDER BY rowid DESC LIMIT 1', [
    cid,
  ]);
  const latest = rows[0];
  if (
    !latest ||
    ![
      'election_undo',
      'election_redo',
      'undo_vacations',
      'redo_vacations',
      'reconstruction_back',
      'reconstruction_cancel',
    ].includes(latest.action)
  )
    return { restored: false };
  let metadata: any;
  try {
    metadata = JSON.parse(latest.after_json);
  } catch {
    return { restored: false };
  }
  if (metadata?.version !== version) return { restored: false };
  const restored = { restored: true };
  if (
    (latest.action === 'reconstruction_back' || latest.action === 'reconstruction_cancel') &&
    metadata.recordedAvailability
  )
    return { restored: true, recordedAvailability: metadata.recordedAvailability };
  const undo = latest.action === 'election_undo' || latest.action === 'undo_vacations';
  const redo = latest.action === 'election_redo' || latest.action === 'redo_vacations';
  if (!undo && !redo) return restored;
  let originalId =
    latest.action === 'election_undo'
      ? metadata.undoTargetId
      : latest.action === 'undo_vacations'
        ? metadata.undone
        : undefined;
  if (redo) {
    const undoId = latest.action === 'election_redo' ? metadata.redoTargetId : metadata.undone;
    if (typeof undoId !== 'string') return restored;
    const undone = await repo.all('SELECT after_json FROM audit WHERE campaign_id=? AND id=?', [cid, undoId]);
    if (!undone[0]) return restored;
    try {
      const parent = JSON.parse(undone[0].after_json);
      originalId = latest.action === 'election_redo' ? parent.undoTargetId : parent.undone;
    } catch {
      return restored;
    }
  }
  if (typeof originalId !== 'string') return restored;
  const original = await repo.all('SELECT after_json FROM audit WHERE campaign_id=? AND id=?', [cid, originalId]);
  if (!original[0]) return restored;
  try {
    const details = JSON.parse(original[0].after_json);
    const certified = details?.impact,
      administrative = details?.availabilityHistory;
    const recordedAvailability = undo
      ? (certified?.availabilityBefore ?? administrative?.before)
      : (certified?.availabilityAfter ?? administrative?.after);
    return recordedAvailability ? { restored: true, recordedAvailability } : restored;
  } catch {
    return restored;
  }
}
