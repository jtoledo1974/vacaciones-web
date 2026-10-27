'use client';
import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { PreferenceUsageValue } from './preferences-editor';

type SavedPreference = {
  member_id: string;
  dates?: string[];
  persistent?: boolean;
  mode?: PreferenceUsageValue['mode'];
  waitMinutes?: number;
  labels?: Record<string, string>;
};
type Confirm = (
  message: string,
  detail?: string,
  options?: { title?: string; cancelLabel?: string; confirmLabel?: string },
) => Promise<boolean>;

/**
 * The unsaved edit of one member's preference list: it follows the saved list until
 * edited, warns before leaving with changes and can discard them.
 */
export function usePreferenceDraft(input: {
  preferences: SavedPreference[];
  memberId: string;
  busy: boolean;
  confirm: Confirm;
  navigationGuard?: MutableRefObject<null | (() => Promise<boolean>)>;
  onPreferenceEdit?: () => void;
}) {
  const { preferences, memberId, busy, confirm, navigationGuard, onPreferenceEdit } = input;
  const existing = preferences.find((p) => p.member_id === memberId);
  const serverPreferences = JSON.stringify({
    dates: existing?.dates ?? [],
    persistent: existing?.persistent ?? false,
    usage: { mode: existing?.mode ?? 'immediate', waitMinutes: existing?.waitMinutes ?? 0 },
    labels: existing?.labels ?? {},
  });
  const [dates, setDates] = useState<string[]>([]);
  const [persistent, setPersistent] = useState(false),
    [preferenceMessage, setPreferenceMessage] = useState('');
  const [usage, setUsage] = useState<PreferenceUsageValue>({ mode: 'immediate', waitMinutes: 0 }),
    [labels, setLabels] = useState<Record<string, string>>({});
  const lastSavedPreferences = useRef({ memberId: '', value: serverPreferences });
  // Names of cycles that left the list do not count as a change.
  const keptLabels = Object.fromEntries(
    dates.filter((d: string) => labels[d]?.trim()).map((d: string) => [d, labels[d].trim()]),
  );
  const draftValue = JSON.stringify({ dates, persistent, usage, labels: keptLabels });
  const dirty = draftValue !== serverPreferences;
  useEffect(() => {
    const previous = lastSavedPreferences.current;
    if (previous.memberId !== memberId || draftValue === previous.value) {
      const incoming = JSON.parse(serverPreferences);
      setDates(incoming.dates);
      setPersistent(incoming.persistent);
      setUsage(incoming.usage);
      setLabels(incoming.labels);
    }
    lastSavedPreferences.current = { memberId, value: serverPreferences };
  }, [memberId, serverPreferences]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  async function leavePreferences() {
    if (busy) return false;
    if (!dirty) return true;
    if (
      !(await confirm(
        'Has modificado tu lista de preferencias, pero aún no la has guardado. Si descartas los cambios, recuperarás la última lista guardada. Si no tenías ninguna, la lista quedará vacía.',
        undefined,
        { title: '¿Descartar los cambios?', cancelLabel: 'Seguir editando', confirmLabel: 'Descartar cambios' },
      ))
    )
      return false;
    const saved = JSON.parse(serverPreferences);
    setDates(saved.dates);
    setPersistent(saved.persistent);
    setUsage(saved.usage);
    setLabels(saved.labels);
    setPreferenceMessage('');
    return true;
  }
  useEffect(() => {
    if (navigationGuard) navigationGuard.current = leavePreferences;
    return () => {
      if (navigationGuard) navigationGuard.current = null;
    };
  });
  function edit<T>(set: (value: T) => void, message: string) {
    return (next: T) => {
      set(next);
      setPreferenceMessage(message);
      onPreferenceEdit?.();
    };
  }
  return {
    dates,
    persistent,
    usage,
    labels,
    keptLabels,
    dirty,
    preferenceMessage,
    setPreferenceMessage,
    leavePreferences,
    editDates: edit(setDates, 'Lista modificada. Cambios sin guardar.'),
    editPersistence: edit(setPersistent, 'Uso de la lista modificado. Cambios sin guardar.'),
    editLabels: edit(setLabels, 'Nombres modificados. Cambios sin guardar.'),
    editUsage: edit(setUsage, 'Uso de la lista modificado. Cambios sin guardar.'),
  };
}
