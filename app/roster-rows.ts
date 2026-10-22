/** Fields of one editable team roster row that determine whether it is empty. */
export type EditableRosterRow = {
  memberId?:string;
  code:string;
  label:string;
  seniority:string;
  previousScore:string;
  provider:string;
  subject:string;
  legacyKey?:string;
};

/** Only untouched, unsaved rows are disposable; never drop existing members. */
export function isBlankNewRosterRow(row:EditableRosterRow):boolean {
  return !row.memberId
    && !row.code.trim()
    && !row.label.trim()
    && !row.seniority.trim()
    && !row.previousScore.trim()
    && !row.provider
    && !row.subject.trim()
    && !row.legacyKey;
}

/** Remove placeholder rows before validating or persisting a roster. */
export function withoutBlankNewRosterRows<T extends EditableRosterRow>(rows:T[]):T[] {
  return rows.filter(row=>!isBlankNewRosterRow(row));
}
