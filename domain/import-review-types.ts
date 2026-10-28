/** A choice ({round, code, date}) or a deferred turn ({round, code, deferred: true}). */
export type SelectionStep = { round: number; code: string; date?: string; deferred?: true };
export type ImportFinding = SelectionStep & { step: number; message: string };
export type ImportReview = {
  version: number;
  selections: number;
  sequence: SelectionStep[];
  findings: ImportFinding[];
  blockingIssues: string[];
  reviewToken: string;
};
