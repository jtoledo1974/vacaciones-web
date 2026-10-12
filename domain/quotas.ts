// Direct port of Vac!T5:T50, S5:S50, AA5:AA50 and their summary cells.
// These are separate from the DATOS planning quotas in the original workbook.
export function relationQuotas(periods: number[], occupied: number[], p: {
    people: number;
    necessary: number;
    baseTotal: number;
    minimum: number;
    base: number;
    maximum: number;
    graceJanuary: number;
    graceOctober: number;
}) {
    const counts = [0, 0, 0];
    periods.forEach(x => counts[x]++);
    const summerBase = 2 * counts[1]; // Vac!Y3 explicitly uses 2, independent of DATOS!F6.
    const summerExtra = Math.max(0, p.people * 2 - summerBase); // Vac!G3
    const deficit = p.necessary - p.baseTotal;
    const extra = deficit > 0 ? deficit : summerExtra; // G2
    const T = occupied.map(n => n > p.maximum ? p.maximum : n > p.base ? n : p.base);
    const T4 = T.reduce((a, b) => a + b, 0) - p.baseTotal;
    const S = occupied.map(n => n >= p.maximum ? (T4 <= extra + p.graceJanuary + p.graceOctober ? p.maximum : p.base) : n > p.base ? n : p.base);
    const sumT = (period: number) => T.reduce((n, v, i) => n + (periods[i] === period ? v : 0), 0);
    const AD2 = Math.min(p.graceJanuary, sumT(0) - counts[0] * p.base), AD3 = Math.min(p.graceOctober, sumT(2) - counts[2] * p.base);
    const AC2 = AD2 < p.graceJanuary ? 0 : sumT(0) - counts[0] * p.base - AD2, AC3 = AD3 < p.graceOctober ? 0 : sumT(2) - counts[2] * p.base - AD3;
    const AE2 = Math.max(extra - summerExtra, 0) - (AC2 + AC3) + (p.graceJanuary - AD2), AE3 = Math.max(extra - summerExtra, 0) - (AC2 + AC3) + (p.graceOctober - AD3);
    const Z3 = S.reduce((n, v, i) => n + (periods[i] === 1 ? v : 0), 0) - summerBase;
    const AA1 = p.necessary - occupied.slice(0, 45).reduce((a, b) => a + b, 0); // U51 sums rows 5:49, preserving the original boundary.
    return S.map((max, i) => ({ min: p.minimum, base: p.base, max, available: AA1 > 0 && (occupied[i] < max || (occupied[i] === max && max < p.maximum && (periods[i] === 0 ? AE2 > 0 : periods[i] === 1 ? Z3 < summerExtra : AE3 > 0))) }));
}
