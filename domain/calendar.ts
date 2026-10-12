export const ENGINE_VERSION = 'excel-v21.1.3x-port-1';
export const dayMs = 86400000;
export function serial(iso: string) { const d = new Date(iso + 'T00:00:00Z'); if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || !Number.isFinite(+d) || d.toISOString().slice(0, 10) !== iso)
    throw new Error('Fecha no válida'); return Math.round(+d / dayMs) + 25569; }
export function iso(n: number) { return new Date((n - 25569) * dayMs).toISOString().slice(0, 10); }
export function date(y: number, m: number, d: number) { return iso(Math.round(Date.UTC(y, m - 1, d) / dayMs) + 25569); }
export function leap(y: number) { return y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0); }
export function easter(y: number) { if (!Number.isInteger(y) || y < 1583 || y > 9999)
    throw new Error('Año no válido'); const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451), n = h + l - 7 * m + 114; return serial(date(y, Math.floor(n / 31), n % 31 + 1)); }
export function weekday(n: number) { return (new Date((n - 25569) * dayMs).getUTCDay() + 6) % 7 + 1; }
export type Holiday = {
    label: string;
    month?: number;
    day?: number;
    offset?: number;
    score: number;
    shiftSunday?: boolean;
    saturdayBase?: boolean;
    nextYear?: boolean;
    corpus?: boolean;
};
export type Config = {
    cycleLength: number;
    cyclesPerPerson: number;
    summerPerPerson: number;
    summerStart: string;
    summerEnd: string;
    correturnos: string;
    excludeLast: boolean;
    excludePenultimate: boolean;
    min: number[];
    base: number[];
    grace: number[];
    commonGrace: boolean;
    commonConvention: boolean;
    conventionJanuary: number;
    weights: number[];
    relation?: {
        minimum: number;
        base: number;
        maximum: number;
        graceJanuary: number;
        graceOctober: number;
    };
    baseScores: {
        month: number;
        day: number;
        score: number;
        nextYear?: boolean;
    }[];
    specialCycles: string[];
    rotation: string[][];
    holidays: Holiday[];
};
export function validateConfig(c: Config, y: number) { if (!c || !Number.isInteger(y) || y < 2013 || y > 2200)
    throw new Error('Ejercicio entre 2013 y 2200'); for (const k of ['cycleLength', 'cyclesPerPerson', 'summerPerPerson', 'conventionJanuary'] as const)
    if (!Number.isInteger(c[k]) || c[k] < 0 || c[k] > 100)
        throw new Error('Parámetro numérico no válido'); if (c.cycleLength !== 8)
    throw new Error('El original solo define la rotación de 8 días. Otros ciclos requieren una regla validada.'); if (c.summerPerPerson > c.cyclesPerPerson)
    throw new Error('Los ciclos de verano superan el total'); for (const k of ['min', 'base', 'grace', 'weights'] as const)
    if (!Array.isArray(c[k]) || c[k].length !== (k === 'weights' ? 6 : 3) || c[k].some(n => !Number.isFinite(n) || n < 0 || n > 10000))
        throw new Error('Cupos o ponderaciones no válidos'); if (c.base.some((b, i) => b < c.min[i]))
    throw new Error('El cupo base no puede ser menor que el mínimo'); if (c.summerStart > c.summerEnd)
    throw new Error('Intervalo de verano no válido'); for (const k of ['summerStart', 'summerEnd', 'correturnos'] as const) {
    serial(c[k]);
    if (c[k].slice(0, 4) !== String(y))
        throw new Error('Las fechas deben pertenecer al ejercicio');
} if (!Array.isArray(c.rotation) || c.rotation.length !== 8 || c.rotation.some(r => r.length !== 8 || r.some(s => !['M', 'T', 'N', ' '].includes(s))))
    throw new Error('Rotación no válida'); if (!Array.isArray(c.baseScores) || !c.baseScores.length || c.baseScores.length > 100)
    throw new Error('Baremo base no válido'); for (const s of c.baseScores)
    if (s.month < 1 || s.month > 12 || s.day < 1 || s.day > 31 || !Number.isFinite(s.score) || s.score < 0 || s.score > 10000)
        throw new Error('Baremo no válido'); if (!Array.isArray(c.holidays) || c.holidays.length > 100 || !Array.isArray(c.specialCycles) || c.specialCycles.length > 50)
    throw new Error('Festivos no válidos'); for (const h of c.holidays)
    if (typeof h.label !== 'string' || h.label.length > 80 || !Number.isFinite(h.score) || h.score < 0 || h.score > 10000 || (h.offset === undefined && (!h.month || !h.day)) || (h.offset !== undefined && (!Number.isInteger(h.offset) || Math.abs(h.offset) > 400)))
        throw new Error('Festivo no válido'); if (c.relation) {
    for (const n of Object.values(c.relation))
        if (!Number.isInteger(n) || n < 0 || n > 100)
            throw new Error('Cupo de relación no válido');
    if (c.relation.minimum > c.relation.base || c.relation.base > c.relation.maximum)
        throw new Error('Orden de cupos no válido');
} c.specialCycles.forEach(serial); return c; }
export function holidayDates(y: number, c: Config) { return c.holidays.map(h => { let n = h.offset !== undefined ? easter(y) + h.offset : serial(date(y + (h.nextYear ? 1 : 0), h.month!, h.day!)); if (h.shiftSunday && weekday(n) === 7)
    n++; return { ...h, date: iso(n), serial: n }; }); }
export function dailyScorer(y: number, c: Config) {
    const scores = c.baseScores.map(s => ({ ...s, n: serial(date(y + (s.nextYear ? 1 : 0), s.month, s.day)) })).sort((a, b) => a.n - b.n), hs = holidayDates(y, c);
    const intervals = [['Lunes Santo', 'Domingo de Resurrección'], ['Lunes de Feria', 'Domingo de Feria']].map(([start, end]) => ({ a: hs.find(h => h.label === start), b: hs.find(h => h.label === end) }));
    return (n: number) => { let base: number | undefined; for (const s of scores) {
        if (s.n > n)
            break;
        base = s.score;
    } if (base === undefined)
        throw new Error('Falta baremo base para la fecha'); for (const { a, b } of intervals)
        if (a && b && n >= a.serial && n <= b.serial)
            return a.score; const specials = hs.filter(h => h.serial === n).reduce((s, h) => s + (h.saturdayBase && weekday(n) === 6 ? base! : h.corpus ? (weekday(n) === 6 ? base! : base! >= 8 ? base! + 1 : 8) : h.score), 0); return specials > 0 ? specials : base; };
}
export function dailyScore(n: number, y: number, c: Config) { return dailyScorer(y, c)(n); }
export function rotationCode(n: number, y: number, team: string, c: Config) { const index = 'ABCDEFGH'.indexOf(team); if (index < 0)
    throw new Error('Equipo no válido'); const after = (Math.floor(y / 4) % 8 + index) % 8; const before = (after + 7) % 8; const boundary = serial(c.correturnos) + c.cycleLength - 1; return c.rotation[((n % 8) + 8) % 8][leap(y) && n < boundary ? before : after]; }
export function calendar(y: number, team: string, c: Config) { validateConfig(c, y); const scoreDay = dailyScorer(y, c); const jan = serial(date(y, 1, 1)); let night = jan; while (night < jan + 21 && rotationCode(night, y, team, c) !== 'N')
    night++; let first = night - 4 >= jan ? night - 4 : night + 4; const out: {
    date: string;
    end: string;
    score: number;
    period: number;
    correturnos: boolean;
    special: boolean;
}[] = []; let ctSeen = false; for (let i = 0; i < 46; i++) {
    const isCT = !ctSeen && first + c.cycleLength >= serial(c.correturnos);
    if (isCT)
        ctSeen = true;
    if ((i === 44 && c.excludePenultimate) || (i === 45 && c.excludeLast))
        break;
    let score = 0;
    for (let d = 0; d < c.cycleLength; d++)
        score += scoreDay(first + d);
    out.push({ date: iso(first), end: iso(first + c.cycleLength - 1 + (leap(y) && isCT ? 1 : 0)), score, period: first < serial(c.summerStart) ? 0 : first <= serial(c.summerEnd) ? 1 : 2, correturnos: isCT, special: c.specialCycles.includes(iso(first)) });
    first += c.cycleLength + (leap(y) && isCT ? 1 : 0);
} return out; }
