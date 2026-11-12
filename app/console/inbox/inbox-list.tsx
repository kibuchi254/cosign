'use client';

import Link from 'next/link';
import { useState } from 'react';
import { REASON_LABEL } from '@/lib/cosign-format';
import type { ReasonCode } from '@/lib/cosign-types';
import { approveMany } from '../actions';
import { Submit, withToast } from '../client';
import { Avatar, Card } from '../ui';

type Item = { id: string; hash: string; vendor: string; label: string; amount: string; reason: ReasonCode | null; count: number; waited: string; blockedForBulk: boolean };

/** The queue. Tick several to approve them together; items the AI flagged must be opened one by one. */
export function InboxList({ items, selectedId }: { items: Item[]; selectedId: string | null }) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const eligible = items.filter((i) => !i.blockedForBulk);
  const toggle = (id: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const chosen = items.filter((i) => picked.has(i.id));

  return (
    <Card>
      <div className="flex items-center gap-3 border-b border-cs-rule px-4 py-3">
        <input
          type="checkbox"
          aria-label="Select all that can be approved together"
          checked={eligible.length > 0 && chosen.length === eligible.length}
          onChange={(e) => setPicked(new Set(e.target.checked ? eligible.map((i) => i.id) : []))}
          disabled={eligible.length === 0}
          className="size-4 accent-[var(--cs-sign)]"
        />
        <p className="text-sm font-bold">
          {items.length} waiting <span className="font-normal text-cs-faint">oldest first</span>
        </p>
      </div>
      {chosen.length > 0 && (
        <form
          action={withToast(approveMany, 'Approved', () => setPicked(new Set()))}
          className="cs-rise flex items-center justify-between gap-2 border-b border-cs-rule bg-cs-sign-wash px-4 py-2.5"
        >
          {chosen.map((c) => (
            <input key={c.id} type="hidden" name="item" value={`${c.id}|${c.hash}|${c.label}`} />
          ))}
          <span className="text-sm font-semibold text-cs-sign-deep">{chosen.length} selected</span>
          <Submit pending="Signing…" size="sm" variant="success">
            Approve {chosen.length}
          </Submit>
        </form>
      )}
      <ul className="divide-y divide-cs-rule">
        {items.map((i) => {
          const active = i.id === selectedId;
          return (
            <li key={i.id} className={`flex items-center gap-3 px-4 py-3 ${active ? 'bg-cs-sign-wash' : 'hover:bg-cs-hover'}`}>
              <input
                type="checkbox"
                aria-label={i.blockedForBulk ? `${i.label}: flagged by the AI, review it on its own` : `Select ${i.label}`}
                title={i.blockedForBulk ? 'Flagged by the AI. Open it and approve it on its own.' : undefined}
                checked={picked.has(i.id)}
                disabled={i.blockedForBulk}
                onChange={() => toggle(i.id)}
                className="size-4 accent-[var(--cs-sign)] disabled:opacity-30"
              />
              <Link href={`/console/inbox?id=${i.id}`} aria-current={active ? 'true' : undefined} className="flex min-w-0 flex-1 items-center gap-3">
                <Avatar name={i.vendor} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-sm font-semibold">{i.vendor}</span>
                    <span className="shrink-0 text-sm font-semibold tabular-nums">{i.amount}</span>
                  </span>
                  <span className="flex items-baseline justify-between gap-2 text-xs text-cs-soft">
                    <span className="truncate">
                      {i.reason ? REASON_LABEL[i.reason] : 'Needs a look'}
                      {i.count > 1 && ` +${i.count - 1}`}
                    </span>
                    <span className="shrink-0 text-cs-faint">{i.waited}</span>
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
