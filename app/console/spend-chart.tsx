'use client';

// Paid per day, last 14 days. One series (so no legend), thin rounded columns, recessive grid,
// and a hover tooltip that also tells you what was held and stopped that day.

import { useState } from 'react';

export type DayBucket = { day: string; label: string; paid: number; held: number; blocked: number; paidCount: number };

const fmt = (cents: number, currency: string) =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency, maximumFractionDigits: cents % 100 === 0 ? 0 : 2 });

export function SpendChart({ days, currency, compact = false }: { days: DayBucket[]; currency: string; compact?: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...days.map((d) => d.paid));
  // A round axis top: 1, 2 or 5 times a power of ten.
  const mag = 10 ** Math.floor(Math.log10(max));
  const top = [1, 2, 5, 10].map((m) => m * mag).find((v) => v >= max) ?? max;
  // Compact draws fewer days on a narrower canvas, so the text stays readable on a phone.
  const W = compact ? 340 : 640;
  const H = compact ? 190 : 200;
  const padL = 64;
  const padB = 24;
  const plotW = W - padL - 8;
  const plotH = H - padB - 8;
  const slot = plotW / days.length;
  const barW = Math.min(24, slot * 0.6);
  const y = (v: number) => 8 + plotH - (v / top) * plotH;
  const ticks = [0, top / 2, top];
  const h = hover !== null ? days[hover] : null;

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`Paid per day over the last ${days.length} days`} onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={W - 8} y1={y(t)} y2={y(t)} stroke="var(--cs-rule)" strokeWidth={1} />
            <text x={padL - 8} y={y(t) + 4} textAnchor="end" fontSize={11} fill="var(--cs-ink-faint)">
              {fmt(t, currency)}
            </text>
          </g>
        ))}
        {days.map((d, i) => {
          const x = padL + i * slot + (slot - barW) / 2;
          const bh = d.paid > 0 ? Math.max(3, (d.paid / top) * plotH) : 0;
          const top4 = Math.min(4, bh / 2);
          return (
            <g key={d.day} onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} tabIndex={0} aria-label={`${d.label}: ${fmt(d.paid, currency)} paid`}>
              {/* Hit target larger than the mark. */}
              <rect x={padL + i * slot} y={8} width={slot} height={plotH} fill="transparent" />
              {hover === i && <rect x={padL + i * slot + 2} y={8} width={slot - 4} height={plotH} rx={6} fill="var(--cs-hover)" />}
              {bh > 0 && (
                <path
                  d={`M${x},${y(0)} V${y(0) - bh + top4} Q${x},${y(0) - bh} ${x + top4},${y(0) - bh} H${x + barW - top4} Q${x + barW},${y(0) - bh} ${x + barW},${y(0) - bh + top4} V${y(0)} Z`}
                  fill="var(--cs-sign)"
                  opacity={hover === null || hover === i ? 1 : 0.55}
                />
              )}
              {((days.length - 1 - i) % 2 === 0 || days.length <= 7) && (
                <text x={padL + i * slot + slot / 2} y={H - 6} textAnchor="middle" fontSize={11} fill="var(--cs-ink-faint)">
                  {d.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {h && hover !== null && (
        <div
          className="cs-card pointer-events-none absolute top-0 z-10 min-w-44 px-3 py-2 text-xs"
          style={{ left: `${((padL + hover * slot + slot / 2) / W) * 100}%`, transform: `translateX(${hover > days.length / 2 ? '-105%' : '5%'})`, boxShadow: 'var(--cs-shadow-lift)' }}
        >
          <p className="font-semibold text-cs-ink">{h.label}</p>
          <p className="mt-1 flex justify-between gap-4 text-cs-soft">
            Paid <span className="font-semibold text-cs-ink tabular-nums">{fmt(h.paid, currency)}</span>
          </p>
          <p className="flex justify-between gap-4 text-cs-soft">
            Held for you <span className="text-cs-ink tabular-nums">{fmt(h.held, currency)}</span>
          </p>
          <p className="flex justify-between gap-4 text-cs-soft">
            Stopped <span className="text-cs-ink tabular-nums">{fmt(h.blocked, currency)}</span>
          </p>
        </div>
      )}
    </div>
  );
}
