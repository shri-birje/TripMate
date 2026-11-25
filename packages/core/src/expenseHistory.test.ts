import { describe, expect, it } from 'vitest';
import { changeLines, describePayers, describeShares, historyEntries, revisionsFromRows, snapshotFromJson, splitMethodLabel, whenLabel, type ExpenseSnapshot, type HistoryFormatters } from './expenseHistory';

const A = '00000000-0000-4000-8000-0000000000a1';
const B = '00000000-0000-4000-8000-0000000000b2';
const C = '00000000-0000-4000-8000-0000000000c3';

const names: Record<string, string> = { [A]: 'Asha', [B]: 'Ravi', [C]: 'Dev (left)' };
const f: HistoryFormatters = {
  money: (n) => `₹${(n / 100).toFixed(2).replace(/\.00$/, '')}`,
  person: (id) => names[id] ?? 'Someone',
  category: (k) => (k === null ? 'None' : k[0]!.toUpperCase() + k.slice(1)),
  day: (iso) => iso,
};

const json = (over: Record<string, unknown> = {}) => ({
  title: 'Dinner', amount_minor: 1000, spent_on: '2026-12-28', category_key: 'food', notes: null, split_method: 'equal',
  payers: [{ member_id: A, paid_minor: 1000 }], splits: [{ member_id: A, share_minor: 500 }, { member_id: B, share_minor: 500 }], deleted: false, ...over,
});
const snap = (over: Partial<ExpenseSnapshot> = {}): ExpenseSnapshot => ({ ...snapshotFromJson(json())!, ...over });

describe('reading a stored snapshot', () => {
  it('reads every field, including the typed split values when there are any', () => {
    expect(snapshotFromJson(json())).toEqual({
      title: 'Dinner', amountMinor: 1000, spentOn: '2026-12-28', categoryKey: 'food', notes: null, splitMethod: 'equal',
      payers: [{ memberId: A, paidMinor: 1000 }], shares: [{ memberId: A, shareMinor: 500, inputValue: null }, { memberId: B, shareMinor: 500, inputValue: null }], deleted: false,
    });
    const typed = snapshotFromJson(json({ split_method: 'percentage', splits: [{ member_id: A, share_minor: 600, input_value: 6000 }, { member_id: B, share_minor: 400, input_value: 4000 }] }))!;
    expect(typed.shares.map((s) => s.inputValue)).toEqual([6000, 4000]);
    expect(snapshotFromJson(json({ deleted: true }))!.deleted).toBe(true);
  });

  it('answers null for anything unexpected rather than guessing', () => {
    for (const bad of [null, 'x', [], {}, json({ title: 5 }), json({ amount_minor: 1.5 }), json({ split_method: 'weird' }), json({ payers: 'no' }), json({ payers: [{ member_id: A }] }),
      json({ splits: [{ member_id: A, share_minor: 'x' }] }), json({ splits: [{ member_id: A, share_minor: 1, input_value: 1.5 }] }), json({ notes: 5 }), json({ category_key: 5 })]) {
      expect(snapshotFromJson(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('keeps no user id, email or name anywhere in what it returns (a snapshot only ever holds member ids)', () => {
    const text = JSON.stringify(snapshotFromJson(json({ user_id: 'u1', email: 'a@b.com', display_name: 'Asha' })));
    expect(text).not.toMatch(/u1|a@b\.com|Asha|user_id|email|display_name/);
  });
});

describe('revisions', () => {
  const row = (version: number, action: string, over: Record<string, unknown> = {}) => ({ version, action, snapshot: json(over), changed_by: A, changed_at: '2026-11-25T10:15:00Z' });

  it('come back oldest first, with unknown actions dropped and unreadable snapshots kept as "no details"', () => {
    const list = revisionsFromRows([row(3, 'delete'), row(1, 'create'), { ...row(2, 'update'), snapshot: 'garbage' }, row(4, 'mystery')]);
    expect(list.map((r) => [r.version, r.action])).toEqual([[1, 'create'], [2, 'update'], [3, 'delete']]);
    expect(list[1]!.snapshot).toBeNull();
    expect(list[0]!.changedBy).toBe(A);
  });
});

describe('what changed between two versions', () => {
  it('lists each changed part once, with the previous value', () => {
    const before = snap();
    const after = snap({ title: 'Dinner at the shack', amountMinor: 1200, spentOn: '2026-12-29', categoryKey: 'other', notes: 'extra' });
    expect(changeLines(before, after, f)).toEqual([
      { label: 'Name', before: 'Dinner', after: 'Dinner at the shack' },
      { label: 'Amount', before: '₹10', after: '₹12' },
      { label: 'Day', before: '2026-12-28', after: '2026-12-29' },
      { label: 'Category', before: 'Food', after: 'Other' },
      { label: 'Notes', before: 'None', after: 'extra' },
    ]);
  });

  it('says nothing when nothing a person would care about changed', () => {
    expect(changeLines(snap(), snap(), f)).toEqual([]);
    expect(changeLines(snap(), snap({ deleted: true }), f)).toEqual([]);
  });

  it('who paid and how it was split are described with names, typed values and what each person owes', () => {
    const before = snap();
    const after = snap({
      splitMethod: 'percentage',
      payers: [{ memberId: A, paidMinor: 600 }, { memberId: B, paidMinor: 400 }],
      shares: [{ memberId: A, shareMinor: 600, inputValue: 6000 }, { memberId: B, shareMinor: 400, inputValue: 4000 }],
    });
    const lines = changeLines(before, after, f);
    expect(lines.find((l) => l.label === 'Who paid')).toEqual({ label: 'Who paid', before: 'Asha ₹10', after: 'Asha ₹6, Ravi ₹4' });
    expect(lines.find((l) => l.label === 'Split method')).toEqual({ label: 'Split method', before: 'Equally', after: 'Percentages' });
    expect(lines.find((l) => l.label === 'How it was split')).toEqual({ label: 'How it was split', before: 'Asha (₹5), Ravi (₹5)', after: 'Asha 60% (₹6), Ravi 40% (₹4)' });
  });

  it('describes shares per method, and shortens a long list', () => {
    const base = snap({ shares: [{ memberId: A, shareMinor: 500, inputValue: 2 }, { memberId: B, shareMinor: 250, inputValue: 1 }], splitMethod: 'shares' });
    expect(describeShares(base, f)).toBe('Asha 2 shares (₹5), Ravi 1 share (₹2.50)');
    expect(describeShares({ ...base, splitMethod: 'exact', shares: [{ memberId: A, shareMinor: 0, inputValue: 0 }, { memberId: B, shareMinor: 1000, inputValue: 1000 }] }, f)).toBe('Asha (₹0), Ravi (₹10)');
    const many = Array.from({ length: 7 }, (_, i) => ({ memberId: `0000000${i}`, shareMinor: 100, inputValue: null }));
    expect(describeShares(snap({ shares: many }), f)).toBe('Someone (₹1), Someone (₹1), Someone (₹1), Someone (₹1) and 3 more');
    expect(describePayers(snap({ payers: [{ memberId: C, paidMinor: 300 }] }), f)).toBe('Dev (left) ₹3');
  });

  it('an edit that only reorders people or typed values is not a change', () => {
    const a = snap({ shares: [{ memberId: A, shareMinor: 500, inputValue: null }, { memberId: B, shareMinor: 500, inputValue: null }] });
    const b = snap({ shares: [{ memberId: B, shareMinor: 500, inputValue: null }, { memberId: A, shareMinor: 500, inputValue: null }] });
    expect(changeLines(a, b, f)).toEqual([]);
  });

  it('long notes are shortened', () => {
    const lines = changeLines(snap({ notes: 'n'.repeat(200) }), snap({ notes: null }), f);
    expect(lines[0]!.before.length).toBeLessThanOrEqual(60);
    expect(lines[0]!.before.endsWith('…')).toBe(true);
  });
});

describe('the history as people read it', () => {
  const rows = [
    { version: 1, action: 'create', snapshot: json(), changed_by: A, changed_at: '2026-11-25T10:15:00Z' },
    { version: 2, action: 'update', snapshot: json({ amount_minor: 1200, payers: [{ member_id: A, paid_minor: 1200 }], splits: [{ member_id: A, share_minor: 600 }, { member_id: B, share_minor: 600 }] }), changed_by: B, changed_at: '2026-11-25T11:00:00Z' },
    { version: 3, action: 'delete', snapshot: json({ amount_minor: 1200, deleted: true, payers: [{ member_id: A, paid_minor: 1200 }], splits: [{ member_id: A, share_minor: 600 }, { member_id: B, share_minor: 600 }] }), changed_by: A, changed_at: '2026-11-25T12:00:00Z' },
    { version: 4, action: 'restore', snapshot: json({ amount_minor: 1200, payers: [{ member_id: A, paid_minor: 1200 }], splits: [{ member_id: A, share_minor: 600 }, { member_id: B, share_minor: 600 }] }), changed_by: C, changed_at: '2026-11-25T13:00:00Z' },
  ];
  const entries = historyEntries(revisionsFromRows(rows), f);

  it('newest first, with who did it by NAME (a former member keeps "(left)") and when', () => {
    expect(entries.map((e) => [e.version, e.headline, e.who])).toEqual([[4, 'Restored', 'Dev (left)'], [3, 'Deleted', 'Asha'], [2, 'Edited', 'Ravi'], [1, 'Added', 'Asha']]);
    for (const e of entries) expect(e.when).toMatch(/^\d{1,2} \w{3} 2026, \d{1,2}:\d{2} (am|pm)$/);
  });

  it('an addition has a one-line summary; an edit shows what changed with the previous value; deletes and restores add no lines', () => {
    expect(entries[3]!.summary).toBe('₹10 · Food · 2026-12-28 · equally');
    expect(entries[3]!.lines).toEqual([]);
    expect(entries[2]!.lines.map((l) => [l.label, l.before, l.after])).toEqual([['Amount', '₹10', '₹12'], ['Who paid', 'Asha ₹10', 'Asha ₹12'], ['How it was split', 'Asha (₹5), Ravi (₹5)', 'Asha (₹6), Ravi (₹6)']]);
    expect(entries[1]!.lines).toEqual([]);
    expect(entries[0]!.lines).toEqual([]);
    expect(entries[2]!.summary).toBeNull();
  });

  it('exposes nothing but names, amounts and words: no account id, email or raw member id', () => {
    const text = JSON.stringify(entries);
    expect(text).not.toMatch(/00000000-0000-4000|@|user_id|email/);
  });

  it('an unreadable snapshot still gives an entry (headline, who, when) with no details', () => {
    const e = historyEntries(revisionsFromRows([{ version: 1, action: 'create', snapshot: null, changed_by: A, changed_at: '2026-11-25T10:15:00Z' }, { version: 2, action: 'update', snapshot: 'x', changed_by: B, changed_at: '2026-11-25T11:00:00Z' }]), f);
    expect(e.map((x) => [x.headline, x.who, x.lines.length, x.summary])).toEqual([['Edited', 'Ravi', 0, null], ['Added', 'Asha', 0, null]]);
  });
});

describe('labels', () => {
  it('names the methods and formats a moment, or says it is unknown', () => {
    expect(['equal', 'exact', 'percentage', 'shares'].map((m) => splitMethodLabel(m as never))).toEqual(['Equally', 'Exact amounts', 'Percentages', 'Shares']);
    expect(whenLabel('not a date')).toBe('an unknown time');
    expect(whenLabel('2026-11-25T10:15:00Z')).toMatch(/2026/);
  });
});
