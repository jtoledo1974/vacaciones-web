'use client';
import { useEffect, useState } from 'react';
import { api } from './api-client';

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

/** «Antigüedad»: the signed-in controller's own entitlement, read-only for now. */
export default function VaSection() {
  const [va, setVa] = useState<{ year: number | null; admin: boolean; me: Me | null } | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    api('va/me')
      .then(setVa)
      .catch((e) => setError(e.message));
  }, []);
  if (error) return <div className="alert error">{error}</div>;
  if (!va) return <div className="panel empty">Cargando tu derecho…</div>;
  const me = va.me;
  return (
    <section className="panel va-right" aria-label="Mi derecho">
      <div className="eyebrow">MI DERECHO · {va.year}</div>
      {!me ? (
        <p>
          Tu cuenta no está vinculada a ninguna persona del censo de {va.year}.
          {va.admin && ' Como administrador de VA, revisa el censo en Administración.'}
        </p>
      ) : me.status === 'missing_date' ? (
        <p>Tu antigüedad está pendiente de validar. Contacta con la administración de VA.</p>
      ) : (
        <>
          <div className="va-right-main">
            <span>
              {me.years} años de antigüedad
              {me.controllerNumber !== null && <> · CTA {me.controllerNumber.toLocaleString('es-ES')}</>}
            </span>
            <strong>{me.days ? me.days + (me.days === 1 ? ' día' : ' días') : 'Sin derecho'}</strong>
          </div>
          <p className="muted">
            Antigüedad en ENAIRE desde el {spanishDate(me.seniority!)}.{' '}
            {me.status === 'entitled'
              ? `Saldo ${me.days} · todavía no has elegido ningún día.`
              : `Tendrás derecho a partir de ${me.firstYear}, el año en que cumples 20 años de antigüedad.`}
          </p>
        </>
      )}
      <p className="muted">La elección de días se abrirá al terminar las vacaciones ordinarias.</p>
    </section>
  );
}
