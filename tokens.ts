// tokens.ts — Beast Mode token ledger (Pass 3)
//
// The spend side of the token economy. Design agreed June 2026:
//   - Users pay the FIXED table price from pricing.js (known pre-flight);
//     actual provider cost is logged for margin tracking, never billed.
//   - 1 token = $0.01 retail. Balances and deltas are INTEGERS, always.
//   - HOLD → SETTLE → REFUND around every generation:
//       hold    debit the full quoted batch before the provider call
//       settle  keep tokens for images actually delivered, refund the rest
//       refund  return the whole hold when the provider call fails
//   - Balance lives at ["tokens", emailHash]; every movement also lands in an
//     APPEND-ONLY ledger at ["ledger", emailHash, ts, uuid]. The ledger is the
//     source of truth and the future Stripe reconciliation surface — a
//     purchase is just another { type:"grant" } entry.
//   - All balance mutations go through one atomic compare-and-swap loop
//     (versionstamp check + retry), so two concurrent tabs cannot overdraft.
//
// SIGNUP GRANT is LAZY: the balance record is created with SIGNUP_GRANT on
// first touch (first balance read or first hold) via an atomic
// create-if-absent. Sessions are only issued to verified accounts, so "first
// touch through a session" == "verified user", with no auth.ts → tokens.ts
// import (which would be circular: tokens.ts already imports kv from auth.ts).
//
// Negative balances are PERMITTED for grant/refund paths (Stripe disputes
// will need them later); they are NEVER permitted for holds — generation
// always requires balance >= quoted total.

import { kv } from "./auth.ts";

export const SIGNUP_GRANT = 50; // ≈ one Nano Banana Pro 4K + a pile of drafts
const RETRIES = 5;

// ── UNLIMITED TEST ACCOUNTS ──────────────────────────────────────────────
// These emailHashes (SHA-256(lowercased email).slice(0,32)) bypass the token
// ledger entirely: holds always succeed and debit nothing, settle/refund are
// no-ops, and getBalance reports a sentinel so the UI never blocks. The
// generation path in main.ts is untouched, so these accounts still hit
// Runware / the Gemini API for real — they just aren't metered.
//   pete@artbot5000.com   pasmith984@gmail.com
//   test1@artbot5000.com  test2@artbot5000.com
export const UNLIMITED_HASHES = new Set<string>([
  "9e3b241ca0c59deb3215330953f3c8a9", // pete@artbot5000.com
  "30efe663f9c51af805ab389a0b142d18", // pasmith984@gmail.com
  "5792455ffee52ae98982f962f154e831", // test1@artbot5000.com
  "8f5d614b01b73396c5cf34d6d52ed031", // test2@artbot5000.com
]);
const UNLIMITED_BALANCE = 999_999_999; // sentinel shown to unlimited accounts

export interface BalanceRec {
  balance: number;
  updated: number;
}

export interface LedgerEntry {
  at: string;
  type: "grant" | "hold" | "settle" | "refund";
  tokens: number; // SIGNED delta this entry applied to the balance
  ref?: string; // groups hold/settle/refund belonging to one generation
  model?: string;
  images?: number;
  chargedTokens?: number;
  actualCostUsd?: number | null; // provider cost — margin observability only
  note?: string;
}

// Ledger writes are best-effort: a ledger I/O failure must never break a
// generation whose balance math already committed. Logged loudly instead.
// Key shape ["ledger", emailHash, ts, seq, uuid]: ts orders across time, the
// monotonic in-process seq breaks same-millisecond ties deterministically
// (uuid alone sorts randomly), uuid guarantees uniqueness across restarts.
let ledgerSeq = 0;
async function writeLedger(emailHash: string, entry: LedgerEntry): Promise<void> {
  try {
    await kv.set(["ledger", emailHash, Date.now(), ++ledgerSeq, crypto.randomUUID()], entry);
  } catch (e) {
    console.error("LEDGER WRITE FAILED (balance already moved):", emailHash, entry.type, (e as Error).message);
  }
}

// Read-only balance peek — NO lazy init. For admin listings etc., where
// looking must not create signup grants.
export async function peekBalance(emailHash: string): Promise<number | null> {
  const rec = await kv.get<BalanceRec>(["tokens", emailHash]);
  return rec.value?.balance ?? null;
}

// Ensure the balance record exists (lazy signup grant, exactly once via
// atomic create-if-absent) and return it with its versionstamp for CAS.
async function ensureBalance(emailHash: string): Promise<{ balance: number; versionstamp: string }> {
  for (let i = 0; i < RETRIES; i++) {
    const rec = await kv.get<BalanceRec>(["tokens", emailHash]);
    if (rec.value && rec.versionstamp) {
      return { balance: rec.value.balance, versionstamp: rec.versionstamp };
    }
    const res = await kv.atomic()
      .check({ key: ["tokens", emailHash], versionstamp: null })
      .set(["tokens", emailHash], { balance: SIGNUP_GRANT, updated: Date.now() } as BalanceRec)
      .commit();
    if (res.ok) {
      await writeLedger(emailHash, {
        at: new Date().toISOString(),
        type: "grant",
        tokens: SIGNUP_GRANT,
        note: "signup",
      });
      return { balance: SIGNUP_GRANT, versionstamp: res.versionstamp };
    }
    // Lost the create race — loop re-reads whatever won.
  }
  throw new Error("token balance init contention");
}

// The single mutation path: atomic compare-and-swap with retry.
async function adjust(
  emailHash: string,
  delta: number,
  opts: { allowNegative?: boolean } = {},
): Promise<{ ok: boolean; balance: number }> {
  if (!Number.isInteger(delta)) return { ok: false, balance: NaN };
  for (let i = 0; i < RETRIES; i++) {
    const cur = await ensureBalance(emailHash);
    const next = cur.balance + delta;
    if (next < 0 && !opts.allowNegative) return { ok: false, balance: cur.balance };
    const res = await kv.atomic()
      .check({ key: ["tokens", emailHash], versionstamp: cur.versionstamp })
      .set(["tokens", emailHash], { balance: next, updated: Date.now() } as BalanceRec)
      .commit();
    if (res.ok) return { ok: true, balance: next };
  }
  console.error("token adjust: contention exhausted for", emailHash);
  return { ok: false, balance: NaN };
}

/** Current balance (creates the record with the signup grant on first touch). */
export async function getBalance(emailHash: string): Promise<number> {
  if (UNLIMITED_HASHES.has(emailHash)) return UNLIMITED_BALANCE;
  return (await ensureBalance(emailHash)).balance;
}

/**
 * Debit the full quoted batch before the provider call.
 * ok:false + current balance when insufficient (balance untouched).
 */
export async function holdTokens(
  emailHash: string,
  total: number,
  meta: { model?: string } = {},
): Promise<{ ok: boolean; balance: number; ref: string }> {
  const ref = crypto.randomUUID();
  if (UNLIMITED_HASHES.has(emailHash)) {
    return { ok: true, balance: UNLIMITED_BALANCE, ref };
  }
  if (!Number.isInteger(total) || total <= 0) return { ok: false, balance: NaN, ref };
  const r = await adjust(emailHash, -total);
  if (!r.ok) return { ok: false, balance: r.balance, ref };
  await writeLedger(emailHash, {
    at: new Date().toISOString(),
    type: "hold",
    tokens: -total,
    ref,
    model: meta.model,
  });
  return { ok: true, balance: r.balance, ref };
}

/**
 * Settle a hold after the provider responded: keep chargedTokens, refund the
 * difference (e.g. fewer images delivered than requested). Records the
 * provider's actual cost for margin observability.
 */
export async function settleHold(
  emailHash: string,
  ref: string,
  args: {
    chargedTokens: number;
    refundTokens: number;
    model?: string;
    images?: number;
    actualCostUsd?: number | null;
  },
): Promise<{ balance: number }> {
  if (UNLIMITED_HASHES.has(emailHash)) return { balance: UNLIMITED_BALANCE };
  let balance: number;
  if (args.refundTokens > 0) {
    const r = await adjust(emailHash, args.refundTokens, { allowNegative: true });
    balance = r.ok ? r.balance : (await peekBalance(emailHash)) ?? NaN;
  } else {
    balance = (await peekBalance(emailHash)) ?? NaN;
  }
  await writeLedger(emailHash, {
    at: new Date().toISOString(),
    type: "settle",
    tokens: Math.max(0, args.refundTokens), // delta applied AT settle time
    ref,
    model: args.model,
    images: args.images,
    chargedTokens: args.chargedTokens,
    actualCostUsd: args.actualCostUsd ?? null,
  });
  return { balance };
}

/** Return the entire hold when the provider call failed. */
export async function refundHold(
  emailHash: string,
  ref: string,
  total: number,
  reason: string,
): Promise<{ balance: number }> {
  if (UNLIMITED_HASHES.has(emailHash)) return { balance: UNLIMITED_BALANCE };
  const r = await adjust(emailHash, total, { allowNegative: true });
  const balance = r.ok ? r.balance : (await peekBalance(emailHash)) ?? NaN;
  await writeLedger(emailHash, {
    at: new Date().toISOString(),
    type: "refund",
    tokens: total,
    ref,
    note: reason,
  });
  return { balance };
}

/**
 * Admin / system grant. Negative deltas allowed (corrections, future Stripe
 * dispute claw-backs) and may take the balance below zero — holds then fail
 * until the user is back in credit, which is exactly the wanted behaviour.
 */
export async function grantTokens(
  emailHash: string,
  tokens: number,
  note: string,
): Promise<{ ok: boolean; balance: number }> {
  if (!Number.isInteger(tokens) || tokens === 0 || Math.abs(tokens) > 1_000_000) {
    return { ok: false, balance: NaN };
  }
  const r = await adjust(emailHash, tokens, { allowNegative: true });
  if (!r.ok) return r;
  await writeLedger(emailHash, {
    at: new Date().toISOString(),
    type: "grant",
    tokens,
    note,
  });
  return r;
}

/** Newest-first ledger page for the account UI / admin. */
export async function listLedger(emailHash: string, limit = 50): Promise<LedgerEntry[]> {
  const n = Math.min(200, Math.max(1, Math.floor(limit) || 50));
  const out: LedgerEntry[] = [];
  for await (const e of kv.list<LedgerEntry>({ prefix: ["ledger", emailHash] }, { reverse: true, limit: n })) {
    out.push(e.value);
  }
  return out;
}
