'use client';

/** Shared calendar vocabulary and controls for ordinary cycles and individual VA days. */
export function AvailabilityScale({ maximum = 4 }: { maximum?: 3 | 4 }) {
  return (
    <>
      <b>Plazas libres</b>
      {Array.from({ length: maximum + 1 }, (_, i) => maximum - i).map((n) => (
        <span key={n}>
          <i className={'vac2-key vac2-free-' + n} aria-hidden="true" />
          {n === maximum ? n + ' o más' : n}
        </span>
      ))}
    </>
  );
}

export function MonthNavigation({
  month,
  label,
  onChange,
  className = 'vac2-month-nav',
  previousLabel,
  nextLabel,
}: {
  month: number;
  label: string;
  onChange: (month: number) => void;
  className?: string;
  previousLabel?: string;
  nextLabel?: string;
}) {
  return (
    <div className={className}>
      <button
        type="button"
        className="secondary"
        aria-label={previousLabel}
        disabled={month === 0}
        onClick={() => onChange(month - 1)}
      >
        ← Anterior
      </button>
      <b aria-live="polite">{label}</b>
      <button
        type="button"
        className="secondary"
        aria-label={nextLabel}
        disabled={month === 11}
        onClick={() => onChange(month + 1)}
      >
        Siguiente →
      </button>
    </div>
  );
}
