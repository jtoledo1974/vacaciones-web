/** Fields of one editable team roster row that determine whether it is empty. */
export type EditableRosterRow = {
  memberId?: string;
  code: string;
  label: string;
  seniority: string;
  previousScore: string;
  provider: string;
  subject: string;
  legacyKey?: string;
};

/** Only untouched, unsaved rows are disposable; never drop existing members. */
export function isBlankNewRosterRow(row: EditableRosterRow): boolean {
  return (
    !row.memberId &&
    !row.code.trim() &&
    !row.label.trim() &&
    !row.seniority.trim() &&
    !row.previousScore.trim() &&
    !row.provider &&
    !row.subject.trim() &&
    !row.legacyKey
  );
}

/** Remove placeholder rows before validating or persisting a roster. */
export function withoutBlankNewRosterRows<T extends EditableRosterRow>(rows: T[]): T[] {
  return rows.filter((row) => !isBlankNewRosterRow(row));
}

/** Reconcile a refreshed server roster without discarding edits made during an autosave.
 * Submitted values yield to the server's normalised values; newer edits win.
 * A newly-created member is matched by its submitted nick until it has a server ID.
 */
export function reconcileRosterRows<T extends EditableRosterRow>(
  before: T[],
  received: T[],
  draft: T[],
  submitted: T[] | null = null,
): T[] {
  const used = new Set<number>();
  const editable = ['code', 'label', 'seniority', 'previousScore', 'provider', 'subject', 'legacyKey'] as const;
  const match = (source: T[], remote: T): number =>
    source.findIndex((row) =>
      remote.memberId
        ? row.memberId === remote.memberId
        : !row.memberId && row.code.trim().toUpperCase() === remote.code.trim().toUpperCase(),
    );
  const merged = received.map((remote) => {
    const sentIndex = submitted
      ? submitted.findIndex((row) =>
          row.memberId
            ? row.memberId === remote.memberId
            : row.code.trim().toUpperCase() === remote.code.trim().toUpperCase(),
        )
      : -1;
    const sent = sentIndex >= 0 ? submitted![sentIndex] : null;
    const old = before.find((row) => row.memberId && row.memberId === remote.memberId) ?? null;
    let draftIndex = draft.findIndex(
      (row, i) =>
        !used.has(i) &&
        ((remote.memberId && row.memberId === remote.memberId) ||
          (!row.memberId && row.code.trim().toUpperCase() === remote.code.trim().toUpperCase())),
    );
    if (
      draftIndex < 0 &&
      sent &&
      !sent.memberId &&
      sentIndex < draft.length &&
      !used.has(sentIndex) &&
      !draft[sentIndex].memberId
    )
      draftIndex = sentIndex;
    if (draftIndex < 0) return remote;
    used.add(draftIndex);
    const local = draft[draftIndex],
      baseline = sent ?? old;
    if (!baseline) return { ...remote, ...Object.fromEntries(editable.map((k) => [k, local[k]])) } as T;
    const overrides = Object.fromEntries(editable.filter((k) => local[k] !== baseline[k]).map((k) => [k, local[k]]));
    return { ...remote, ...overrides };
  });
  return [...merged, ...draft.filter((row, i) => !used.has(i) && !row.memberId)];
}
