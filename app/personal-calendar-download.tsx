'use client';

import { CalendarDays } from 'lucide-react';
import { useMemo } from 'react';
import { download } from './download';
import { unitCount, unitWords } from './unit-words';
import { personalVacationCalendar, type PersonalCalendarSource } from './vacations-ics';

/** A one-off calendar import shown only for the linked user of a closed live campaign. */
export default function PersonalCalendarDownload({ data }: { data: PersonalCalendarSource }) {
  const file = useMemo(() => personalVacationCalendar(data), [data]);
  if (!file) return null;
  const { filename, content } = file;
  const units = unitWords(data.election?.policyPresentation);

  function handleDownload() {
    download(filename, content, 'text/calendar;charset=utf-8');
  }

  return (
    <section className="panel">
      <h2>Mis vacaciones en el calendario</h2>
      <p className="muted">
        Importa tus {unitCount(units, file.count)} adjudicados en Google Calendar, Apple Calendar, Outlook u otro
        calendario compatible. Es una importación puntual: no se sincronizarán los cambios posteriores.
      </p>
      <div className="button-row">
        <button type="button" className="secondary" onClick={handleDownload}>
          <CalendarDays size={16} /> Añadir mis vacaciones al calendario
        </button>
      </div>
    </section>
  );
}
