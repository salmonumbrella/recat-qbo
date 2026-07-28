import { describe, expect, it, vi } from 'vitest';
import {
  MAX_TRANSFER_DISCOVERY_TRANSACTIONS,
  TransferDiscoveryOverflowError,
  isTransferPair,
  pairTransfers,
  pickCounterpartAccount,
  transferCandidates,
  type CounterpartAccountLike,
  type PairableTxn,
  type PairTransferStats,
} from './transfers.js';

function t(id: string, amount: number, bankAccount: string, date: string): PairableTxn {
  return { id, amount, bankAccount, date: new Date(date) };
}

describe('isTransferPair', () => {
  const out = t('a', -750, 'Checking ·4821', '2026-07-13');

  it('matches equal |amount|, opposite sign, different account, same day', () => {
    expect(isTransferPair(out, t('b', 750, 'Visa ·0392', '2026-07-13'))).toBe(true);
  });

  it('rejects same sign', () => {
    expect(isTransferPair(out, t('b', -750, 'Visa ·0392', '2026-07-13'))).toBe(false);
  });

  it('rejects same bank account', () => {
    expect(isTransferPair(out, t('b', 750, 'Checking ·4821', '2026-07-13'))).toBe(false);
  });

  it('rejects different amounts', () => {
    expect(isTransferPair(out, t('b', 750.5, 'Visa ·0392', '2026-07-13'))).toBe(false);
  });

  it('honors the 3-day window', () => {
    expect(isTransferPair(out, t('b', 750, 'Visa ·0392', '2026-07-16'))).toBe(true);
    expect(isTransferPair(out, t('b', 750, 'Visa ·0392', '2026-07-17'))).toBe(false);
  });
});

describe('pairTransfers', () => {
  function quadraticReference(txns: PairableTxn[]): Map<string, string> {
    const pairs = new Map<string, string>();
    const used = new Set<string>();
    const sorted = [...txns].sort(
      (a, b) => a.date.getTime() - b.date.getTime() || a.id.localeCompare(b.id),
    );
    for (let index = 0; index < sorted.length; index += 1) {
      const first = sorted[index];
      if (!first || used.has(first.id)) continue;
      for (let secondIndex = index + 1; secondIndex < sorted.length; secondIndex += 1) {
        const second = sorted[secondIndex];
        if (!second || used.has(second.id) || !isTransferPair(first, second)) continue;
        pairs.set(first.id, second.id);
        pairs.set(second.id, first.id);
        used.add(first.id);
        used.add(second.id);
        break;
      }
    }
    return pairs;
  }

  it('pairs the prototype T17/T18 transfer and maps both directions', () => {
    const pairs = pairTransfers([
      t('t17', -750, 'Checking ·4821', '2026-07-13'),
      t('t18', 750, 'Visa ·0392', '2026-07-13'),
      t('t3', -52.4, 'Visa ·0392', '2026-07-01'),
    ]);
    expect(pairs.get('t17')).toBe('t18');
    expect(pairs.get('t18')).toBe('t17');
    expect(pairs.has('t3')).toBe(false);
  });

  it('pairs each txn at most once (greedy by date)', () => {
    const pairs = pairTransfers([
      t('out1', -100, 'Checking', '2026-07-01'),
      t('in1', 100, 'Visa', '2026-07-02'),
      t('in2', 100, 'Savings', '2026-07-03'),
    ]);
    expect(pairs.get('out1')).toBe('in1');
    expect(pairs.has('in2')).toBe(false);
    expect(pairs.size).toBe(2);
  });

  it('returns an empty map for unmatched txns', () => {
    const pairs = pairTransfers([
      t('a', -10, 'Checking', '2026-07-01'),
      t('b', 20, 'Visa', '2026-07-01'),
    ]);
    expect(pairs.size).toBe(0);
  });

  it('matches the prior greedy algorithm on deterministic randomized fixtures', () => {
    let seed = 0x5eed1234;
    const random = () => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed / 0x1_0000_0000;
    };
    for (let fixture = 0; fixture < 50; fixture += 1) {
      const rows = Array.from({ length: 80 }, (_, index) => {
        const day = 1 + Math.floor(random() * 15);
        const cents = 1 + Math.floor(random() * 8);
        const sign = random() < 0.5 ? -1 : 1;
        const bank = `bank-${Math.floor(random() * 4)}`;
        return t(
          `f${String(fixture).padStart(2, '0')}-${String(index).padStart(3, '0')}`,
          sign * cents,
          bank,
          `2026-07-${String(day).padStart(2, '0')}`,
        );
      });
      expect([...pairTransfers(rows).entries()]).toEqual([...quadraticReference(rows).entries()]);
    }
  });

  it('uses bounded indexed queue operations for adversarial same-account buckets', () => {
    const count = 5_000;
    const rows = [
      ...Array.from({ length: count }, (_, index) =>
        t(`negative-${String(index).padStart(5, '0')}`, -10, 'Same bank', '2026-07-01')),
      ...Array.from({ length: count }, (_, index) =>
        t(`positive-${String(index).padStart(5, '0')}`, 10, 'Same bank', '2026-07-02')),
    ];
    const stats: PairTransferStats = { heapPushes: 0, heapPops: 0, queueShifts: 0 };

    expect(pairTransfers(rows, stats).size).toBe(0);
    expect(stats.heapPushes + stats.heapPops + stats.queueShifts).toBeGreaterThan(0);
    expect(stats.heapPushes + stats.heapPops + stats.queueShifts).toBeLessThan(rows.length * 8);
  });
});

describe('transferCandidates', () => {
  it('queries one row beyond the fixed discovery cap and fails closed on overflow', async () => {
    const rows = Array.from(
      { length: MAX_TRANSFER_DISCOVERY_TRANSACTIONS + 1 },
      (_, index) => ({
        id: `txn-${index}`,
        amount: index % 2 === 0 ? -10 : 10,
        bankAccount: index % 2 === 0 ? 'Checking' : 'Visa',
        date: new Date('2026-07-01T00:00:00.000Z'),
      }),
    );
    const db = {
      transaction: {
        findMany: vi.fn(async () => rows),
      },
    };

    await expect(
      transferCandidates('company-1', db as never),
    ).rejects.toBeInstanceOf(TransferDiscoveryOverflowError);
    expect(db.transaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: MAX_TRANSFER_DISCOVERY_TRANSACTIONS + 1,
      }),
    );
  });
});

describe('pickCounterpartAccount', () => {
  const acct = (qboId: string, name: string, active = true): CounterpartAccountLike => ({ qboId, name, active });

  it('picks the single active account matching the name', () => {
    const picked = pickCounterpartAccount([acct('1', 'Checking ·4821'), acct('2', 'Visa ·0392')], 'Visa ·0392');
    expect(picked.qboId).toBe('2');
  });

  it('ignores inactive accounts with the same name', () => {
    const picked = pickCounterpartAccount(
      [acct('1', 'Visa ·0392', false), acct('2', 'Visa ·0392')],
      'Visa ·0392',
    );
    expect(picked.qboId).toBe('2');
  });

  it('fails loudly when no active account matches', () => {
    expect(() => pickCounterpartAccount([acct('1', 'Visa ·0392', false)], 'Visa ·0392')).toThrow(/not found/);
    expect(() => pickCounterpartAccount([], 'Visa ·0392')).toThrow(/not found/);
  });

  it('fails loudly on an ambiguous name instead of guessing', () => {
    expect(() =>
      pickCounterpartAccount([acct('1', 'Checking'), acct('2', 'Checking')], 'Checking'),
    ).toThrow(/ambiguous/);
  });
});
