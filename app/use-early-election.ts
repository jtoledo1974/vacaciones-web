'use client';
import { formatDate } from './cycle-calendar';

type Act = (body: Record<string, unknown>, message: string) => Promise<unknown>;

/**
 * Early election for the viewer (domain/early-election.ts): the cycles the server
 * proved safe to take ahead of their turn, and the confirmed actions on them.
 */
export function useEarlyElection(input: {
  /** The viewer is outside their turn, choosing, on an open and not frozen election. */
  ahead: boolean;
  guaranteed: string[] | undefined;
  memberId: string | null;
  confirm: (message: string) => Promise<boolean>;
  act: Act;
}) {
  const { ahead, guaranteed, memberId, confirm, act } = input;
  const secured: string[] = ahead && memberId ? (guaranteed ?? []) : [];
  async function chooseEarly(c: { date: string; end: string }) {
    if (
      !(await confirm(
        `¿Elegir ${formatDate(c.date)} – ${formatDate(c.end)} por adelantado? Cuenta como tu elección en tu próximo turno. Podrás anularla hasta que llegue.`,
      ))
    )
      return;
    await act({ action: 'early_choose', memberId, date: c.date }, 'Ciclo elegido por adelantado');
  }
  async function cancelEarly(awardId: string, date: string) {
    if (!(await confirm(`¿Anular la elección anticipada de ${formatDate(date)}? Volverás a elegir en tu turno.`)))
      return;
    await act({ action: 'early_cancel', awardId }, 'Elección anticipada anulada');
  }
  return { secured, chooseEarly, cancelEarly };
}
