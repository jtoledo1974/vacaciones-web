'use client';
import { useState } from 'react';
import { useConfirmation } from './confirmation';

/** Lets a linked controller move their access to another ChatGPT Sites email. */
export default function OwnAccountEmail({
  memberId,
  accountVersion,
  busy,
  act,
}: {
  memberId: string;
  accountVersion: number;
  busy: boolean;
  act: (body: Record<string, unknown>, message: string) => Promise<unknown>;
}) {
  const confirm = useConfirmation();
  const [email, setEmail] = useState('');
  async function save(event: React.FormEvent) {
    event.preventDefault();
    const subject = email.trim().toLowerCase();
    if (!subject) return;
    if (
      !(await confirm(
        'Tu acceso pasará a ' +
          subject +
          '. Con la cuenta actual dejarás de ver tu turno y tus preferencias; tendrás que entrar con el nuevo correo. ¿Continuar?',
      ))
    )
      return;
    await act(
      { action: 'link_account', memberId, provider: 'chatgpt', subject, accountVersion },
      'Correo vinculado actualizado',
    );
    setEmail('');
  }
  return (
    <details className="panel own-account-email">
      <summary>Cambiar el correo vinculado a mi controlador</summary>
      <form onSubmit={save}>
        <label>
          Nuevo correo de ChatGPT Sites
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} />
        </label>
        <button className="primary" disabled={busy || !email.trim()}>
          Cambiar correo
        </button>
      </form>
    </details>
  );
}
