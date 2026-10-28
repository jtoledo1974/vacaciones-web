'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '../api-client';
import { normalizeCliCode } from '../../lib/cli-protocol.mjs';

type Session = { principal: { role: string }; identity: { email: string } | null };
type Pairing = { pairing: string; status: string };

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

  // The terminal joins after the code is entered: wait for it before offering approval.
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
              setPairing(result);
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
            Escribe solo un código de una terminal que acabas de iniciar tú. No uses códigos recibidos de otra persona.
          </p>
          <button disabled={busy || !normalizeCliCode(code)}>Continuar</button>
        </form>
      ) : pairing.status === 'waiting' ? (
        <p>Esperando a que la terminal confirme el código…</p>
      ) : pairing.status === 'joined' ? (
        <>
          <p>
            <strong>La terminal tendrá tus permisos de administración, de lectura y escritura, durante 30 días.</strong>{' '}
            Guarda el acceso en su disco y no volverá a pedirlo hasta que caduque.
          </p>
          <p>
            Para retirarlo antes, ejecuta <code>admin-cli logout</code> en esa terminal. Cerrar la sesión de la web no
            lo revoca. Si pierdes tu rol de superadministrador, el acceso deja de funcionar.
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
            Autorizar esta terminal
          </button>
        </>
      ) : pairing.status === 'approved' ? (
        <p>Autorizada.</p>
      ) : (
        <p>
          La terminal canceló la solicitud. Vuelve a ejecutar <code>admin-cli login</code>.
        </p>
      )}
      <p role="status">{message}</p>
    </main>
  );
}
