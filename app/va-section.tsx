'use client';
import { useEffect, useState } from 'react';
import { api } from './api-client';
import VaElectionPanel from './va-election-panel';

type Me = {
  code: string;
  seniority: string | null;
  controllerNumber: number | null;
  years: number | null;
  days: number;
  status: 'entitled' | 'not_entitled' | 'missing_date';
  firstYear: number | null;
};

const spanishDate = (iso: string) => iso.split('-').reverse().join('/');

/** The person's entitlement details. `viewAs` mirrors «ver como» for administrators. */
function VaDays({ viewAs, admin }: { viewAs: { team: string; code: string } | null; admin: boolean }) {
  const [va, setVa] = useState<{ year: number | null; me: Me | null } | null>(null),
    [error, setError] = useState('');
  const query = viewAs
    ? '?equipo=' + encodeURIComponent(viewAs.team) + '&persona=' + encodeURIComponent(viewAs.code)
    : '';
  useEffect(() => {
    api('va/me' + query)
      .then(setVa)
      .catch((e: Error) => setError(e.message));
  }, [query]);
  if (error) return <div className="alert error">{error}</div>;
  if (!va) return <div className="panel empty">Cargando tus días de VA…</div>;
  const me = va.me,
    title = viewAs ? 'Días de VA de ' + viewAs.code : 'Tus días de VA';
  return (
    <section className="panel va-right" aria-label={title}>
      <div className="eyebrow">
        {title.toUpperCase()} · {va.year}
      </div>
      {!me ? (
        <p>
          {viewAs
            ? viewAs.code + ' no está en el censo de VA de ' + va.year + '.'
            : 'Tu cuenta no está vinculada a ninguna persona del censo de ' + va.year + '.'}
          {admin && !viewAs && ' Los días de cada persona están en el censo: Administración › Antigüedad.'}
        </p>
      ) : me.status === 'missing_date' ? (
        <p>La antigüedad está pendiente de validar. Contacta con la administración de VA.</p>
      ) : (
        <>
          <div className="va-right-main">
            <span>
              {me.years} años de antigüedad
              {me.controllerNumber !== null && <> · Nº empleado {me.controllerNumber.toLocaleString('es-ES')}</>}
            </span>
            <strong>{me.days ? me.days + (me.days === 1 ? ' día' : ' días') : 'Sin días de VA'}</strong>
          </div>
          <p className="muted">
            Antigüedad en ENAIRE desde el {spanishDate(me.seniority!)}.{' '}
            {me.status === 'entitled'
              ? `Días reconocidos para el ejercicio: ${me.days}. El saldo y las elecciones se muestran en el calendario de VA.`
              : `Los días de VA empiezan en ${me.firstYear}, el año en que se cumplen 20 años de antigüedad.`}
          </p>
        </>
      )}
    </section>
  );
}

/** «Antigüedad»: the person's own VA days; their administration lives under «Administración». */
export default function VaSection({
  admin,
  viewAs,
}: {
  admin: boolean;
  viewAs: { team: string; code: string } | null;
}) {
  return (
    <>
      {!viewAs && <VaElectionPanel />}
      <VaDays viewAs={viewAs} admin={admin} />
    </>
  );
}
