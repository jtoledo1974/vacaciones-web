'use client';
import { useEffect, useState } from 'react';
import { apiFetch } from './api-client';

/**
 * While an individual turn picks several cycles, the cycles still compatible with
 * those already selected, asked to the server after each pick. null: no query applies.
 */
export function usePairOptions(input: {
  campaignId: string;
  version: number;
  policyVersion: string | null;
  turn: { participants?: string[]; needed?: number } | null;
  selected: string[];
  onError: (message: string) => void;
}) {
  const { campaignId, version, policyVersion, turn, selected, onError } = input;
  const [pairOptions, setPairOptions] = useState<string[] | null>(null),
    [loadingOptions, setLoadingOptions] = useState(false);
  const needed = turn?.needed ?? 0;
  useEffect(() => {
    setPairOptions(null);
    if (turn?.participants?.length !== 1 || needed < 2 || !selected.length || selected.length >= needed) return;
    let active = true;
    setLoadingOptions(true);
    const query = new URLSearchParams();
    selected.forEach((date) => query.append('selected', date));
    apiFetch('election/' + campaignId + '/options?' + query)
      .then(async (response) => {
        const body: { error?: string; version?: number; policyVersion?: string; available?: string[] } =
          await response.json();
        if (!response.ok) throw new Error(body.error);
        if (!active) return;
        if (body.version !== version || (policyVersion && body.policyVersion !== policyVersion)) {
          setPairOptions([]);
          onError('Los cupos se han recalculado con otra versión del reparto. Actualiza la vista antes de confirmar.');
          return;
        }
        setPairOptions(body.available ?? []);
      })
      .catch((e) => {
        if (active) {
          setPairOptions([]);
          onError(e.message);
        }
      })
      .finally(() => {
        if (active) setLoadingOptions(false);
      });
    return () => {
      active = false;
      setLoadingOptions(false);
    };
  }, [selected.join(','), needed, version, policyVersion]);
  return { pairOptions, loadingOptions };
}
