'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '../api-client';
import { normalizeCliCode } from '../../lib/cli-protocol.mjs';

type Session = { principal: { role: string }; identity: { email: string } | null };
type Operation = { method: 'GET' | 'POST'; path: string; backup: boolean };
type Pairing = { pairing: string; status: string; operation: Operation | null };

export default function CliAuthorization() {
  const [session, setSession] = useState<Session | null>(null);
  const [sessionError, setSessionError] = useState('');
  const [code, setCode] = useState('');
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const loadSession = useCallback(() => {
    api('session')
      .then(setSession)
      .catch((error: Error) => setSessionError(error.message || 'No se pudo comprobar tu sesión'));
  }, []);
  useEffect(loadSession, [loadSession]);

  // The terminal joins after the code is entered: wait for its operation to appear.
  useEffect(() => {
    if (!pairing || pairing.status !== 'waiting') return;
    const timer = setInterval(async () => {
      try {
        const next = await api('cli-auth/status?pairing=' + pairing.pairing);
        setPairing((current) => (current ? { ...current, ...next } : current));
      } catch (error) {
        setMessage(error instanceof Error ? error.message : 'No se pudo consultar la terminal');
        setPairing(null);
      }
    }, 1500);
    return () => clearInterval(timer);
  }, [pairing]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setMessage('');
    try {
      await action();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'La operación ha fallado');
    } finally {
      setBusy(false);
    }
  }
  const operation = pairing?.operation;
  return (
    <main className="panel" style={{ maxWidth: 640, margin: '3rem auto', padding: '2rem' }}>
      <h1>Autorizar la terminal</h1>
      {sessionError ? (
        <>
          <p>No se pudo comprobar tu sesión: {sessionError}</p>
          <button
            onClick={() => {
              setSessionError('');
              loadSession();
            }}
          >
            Reintentar
          </button>
        </>
      ) : !session ? (
        <p>Comprobando tu sesión…</p>
      ) : !session.identity ? (
        <a href={'/signin-with-chatgpt?return_to=' + encodeURIComponent('/cli')} target="_top">
          Iniciar sesión con ChatGPT
        </a>
      ) : session.principal.role !== 'superadmin' ? (
        <p>El CLI de administración requiere superadministrador.</p>
      ) : !pairing ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            run(async () => {
              const result = await api('cli-auth/pair', { body: { code } });
              setPairing({ ...result, operation: null });
            });
          }}
        >
          <p>Cuenta: {session.identity.email}</p>
          <label>
            Código que muestra tu terminal
            <input
              value={code}
              onChange={(event) => setCode(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              inputMode="text"
              style={{ fontFamily: 'monospace', fontSize: '1.4rem', display: 'block', width: '100%' }}
            />
          </label>
          <p>
            Escribe solo un código de una orden que acabas de iniciar tú. No uses códigos recibidos de otra persona.
          </p>
          <button disabled={busy || !normalizeCliCode(code)}>Continuar</button>
        </form>
      ) : pairing.status === 'waiting' ? (
        <p>Esperando a que la terminal confirme el código…</p>
      ) : pairing.status === 'joined' && operation ? (
        <>
          <p>La terminal solicita una única operación:</p>
          <p>
            <strong style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>
              {operation.method} {operation.path}
            </strong>
          </p>
          {operation.method === 'POST' ? (
            <p>
              <strong>Esta operación modifica datos.</strong>{' '}
              {operation.backup
                ? 'Antes descargará una copia completa de la base de datos, con datos personales.'
                : 'No se descargará copia previa.'}
            </p>
          ) : operation.path.split('?')[0] === '/api/backup' ? (
            <p>
              <strong>Descargará una copia completa de la base de datos, con datos personales.</strong> No modifica
              datos.
            </p>
          ) : (
            <p>Solo consulta datos.</p>
          )}
          <p>
            La autorización dura como máximo 15 minutos, sirve solo para esa operación (una escritura se ejecuta una
            sola vez) y la terminal la revoca al acabar. Cerrar la sesión de la web no la revoca.
          </p>
          <button
            disabled={busy}
            onClick={() =>
              run(async () => {
                await api('cli-auth/approve', { body: { pairing: pairing.pairing } });
                setPairing({ ...pairing, status: 'approved' });
                setMessage('Terminal autorizada. Puedes cerrar esta pestaña y volver a la terminal.');
              })
            }
          >
            Autorizar esta operación
          </button>
        </>
      ) : pairing.status === 'approved' ? (
        <p>Autorizada.</p>
      ) : (
        <p>La terminal canceló la solicitud. Inicia una orden nueva.</p>
      )}
      <p role="status">{message}</p>
    </main>
  );
}
