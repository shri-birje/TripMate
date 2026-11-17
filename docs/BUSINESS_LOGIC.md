# TripMate — Money Logic Explained

This explains how TripMate works out who owes what. The code is in [packages/core/src](../packages/core/src). It is deliberately plain TypeScript: no database, no screens, no AI. The same code runs in the app, the website and the server, so every platform always gets the same answer.

Rule: **no AI ever calculates, changes or "fixes" a balance.** Every number comes from the functions below.

---

## 1. Money is whole paise

All amounts are **integers in paise** (₹1 = 100). Never decimals.

*Why:* computers cannot store most decimals exactly. In JavaScript `1.15 * 100` is `114.99999999999999`. If we added up many such errors, trips would "lose" paise and friends would argue over pennies. With whole paise, addition is exact.

| Function | Job |
|---|---|
| `parseRupees("1,200.50")` → `120050` | Turns what a user typed into paise using **text handling**, not `parseFloat`. Accepts `1200`, `1,200`, `1,23,456.5`, `₹1,200.50`, `Rs 99`. Rejects negatives, 3+ decimals, letters, blanks, huge values. |
| `formatINR(12345678)` → `"₹1,23,456.78"` | For display only, with Indian digit grouping. Never read this text back for calculations. |
| `addMinor`, `sumMinor`, `assertSafeMinor` | Refuse to continue if a number is not an exactly representable integer. |

---

## 2. Splitting one expense

An expense has an amount, one or more **payers** (who actually paid), and a **split** (who shares the cost and how). Only the members in the split are ever charged (product rule 4). A payer does not have to be a participant (e.g. a host who pays for guests).

| Method | You provide | Rule |
|---|---|---|
| `equal` | the participants | Same share each (see rounding below). "Selected members only" is just a shorter participant list. |
| `percentage` | basis points per person (33.33 % = `3333`) | Must total exactly `10000` (100 %) |
| `exact` | paise per person | Must total exactly the expense amount |
| `shares` | a weight per person (2 : 1 : 1) | Positive whole numbers |

`computeExpense` also checks: the amounts paid add up to the expense amount, nobody is listed twice, there is at least one payer and one participant, nothing is zero or negative where it should not be.

### Rounding: the "largest remainder" method
₹10.00 split three ways is 3.333… each. Rounding each share separately gives 3.33 × 3 = 9.99 — a paisa vanishes.

Instead (`allocateByWeights`):
1. Give everyone their share **rounded down**.
2. Hand the leftover paise out **one each** to the people whose exact share had the biggest fractional part.
3. Ties go to the lowest member id, so the answer never depends on the order people were listed in.

Result: shares **always add up exactly**, and nobody is more than 1 paisa from their exact share. Example: ₹1,000.00 ÷ 3 → 33,334 + 33,333 + 33,333 paise.

Large numbers use BigInt internally so multiplication can never overflow.

---

## 3. Balances

For each member:

```
net = paid − share + sent − received
```

- `paid` — what they paid into shared expenses
- `share` — their portion of those expenses
- `sent` / `received` — repayments they made / got

**net > 0 → should receive money. net < 0 → owes money.** Across a trip the nets always add up to exactly 0 (the engine checks this and refuses to answer if it ever doesn't).

Balances are **never stored**. They are recomputed from the records each time, so editing or deleting an expense can never leave an old number behind.

### What is ignored
- **Deleted** expenses.
- **Personal** expenses (private to one person, outside the group — product rule 9).
- Repayments that are `pending` or `cancelled`.

### Recorded vs confirmed (product rule 12)
Two balances are produced:

| | Counts repayments with status |
|---|---|
| `netConfirmed` (final) | `confirmed` |
| `netProjected` ("once pending confirmations land") | `paid` and `confirmed` |

`awaitingConfirmation = netProjected − netConfirmed`. A repayment moves `pending → paid` (payer says they paid) `→ confirmed` (receiver agrees). The app can show the projected figure labelled "awaiting confirmation" while treating the confirmed figure as final.

### Bad data stops the engine
The engine throws instead of guessing when it meets: an expense whose paid total ≠ shares total (`INCONSISTENT_EXPENSE`), a record naming someone who is not in the trip (`UNKNOWN_MEMBER`), a zero/negative/self repayment, or balances that don't net to zero. Removed members must still be included in the member list so their history keeps counting.

---

## 4. Suggested settlement

`suggestSettlements` turns balances into "who pays whom". Method: repeatedly make the person who owes the **most** pay the person owed the **most**, as much as possible. Someone is fully settled at every step, so there are at most *(people with a balance − 1)* transfers.

**Worked example from the brief** — six friends, ₹48,000 total, ₹8,000 each:

| | Paid | Share | Net |
|---|---|---|---|
| Shri | 15,000 | 8,000 | **+7,000** |
| Rahul | 12,000 | 8,000 | **+4,000** |
| Amit | 10,000 | 8,000 | **+2,000** |
| Kiran | 5,000 | 8,000 | **−3,000** |
| Rohan | 4,000 | 8,000 | **−4,000** |
| Akash | 2,000 | 8,000 | **−6,000** |

Plan: Akash → Shri ₹6,000 · Rohan → Rahul ₹4,000 · Kiran → Amit ₹2,000 · Kiran → Shri ₹1,000. **Four transfers**, which is the true minimum here (Shri + Kiran + Rohan settle among themselves, and Rahul + Amit + Akash do too: 6 people − 2 groups = 4).

**Honest limit:** finding the absolute minimum number of transfers is a hard puzzle in general. This method is right in most friend groups but is not guaranteed minimal in every case. It is always *correct* (everyone ends at zero); it may occasionally use one more transfer than the theoretical best. An exact search can be added later without changing anything else.

The plan is **deterministic**: same balances → same plan, whatever order they arrive in.

---

## 5. "Why do I owe this?"

`explainBalance(member, expenses, repayments)` returns the actual records behind a person's balance: for each expense, what they paid, their share and the effect; for each repayment, direction, status and whether it counts yet. The effects add up to the balance shown, so the explanation can never disagree with the number.

---

## 6. Things worth knowing

- **Bill-by-bill vs one pool.** In the brief, ₹48,000 is shared as one pool (exactly ₹8,000 each). In real use people enter each bill separately, and ₹10,000 ÷ 6 doesn't divide evenly, so each bill rounds by up to a paisa. Totals still match to the paisa overall and nets still add to zero; an individual's balance can differ from the "pooled" figure by a few paise (tested). This is correct behaviour, not a bug.
- **Paise-level fairness.** When a bill can't divide evenly, the spare paise go to the largest remainders and then the lowest id. Over many bills this slightly favours some ids by a few paise at most. Acceptable for now; can be rotated later if it ever matters.
- **Percentages** use basis points (two decimals of a percent) so they are exact integers.

## 7. Error codes
`CoreError.code` is stable and will be mapped to API errors: `INVALID_MONEY_FORMAT`, `INVALID_AMOUNT`, `INVALID_WEIGHT`, `NO_PARTICIPANTS`, `NO_PAYERS`, `DUPLICATE_MEMBER`, `UNKNOWN_MEMBER`, `PERCENT_SUM_INVALID`, `SPLIT_SUM_MISMATCH`, `PAYERS_SUM_MISMATCH`, `INCONSISTENT_EXPENSE`, `BALANCES_NOT_ZERO_SUM`.

## 8. How it is tested
- Worked examples, including the six-friend trip.
- **Property tests**: thousands of randomly generated trips (random members, expenses, split methods, payers, deleted/personal expenses, repayments in every status) must always satisfy: shares add up exactly; nets add to zero; order of records doesn't matter; the suggested plan leaves everyone at exactly zero; the explanation matches the balance.
- **Mutation check** (done once by hand): three deliberate bugs (dropping leftover paise, flipping a repayment sign, wrong settlement amount) were each caught by the tests.
