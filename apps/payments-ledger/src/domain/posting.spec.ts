import { balanceEffect } from './account';
import { CurrencyMismatchError, InvalidAmountError, InvalidPostingError, UnbalancedPostingError } from './errors';
import { PostingLine, reversalLines, validatePosting } from './posting';
import { Account, balanceOf } from './account';
import { netChange } from './posting';

const line = (
  accountId: string,
  direction: PostingLine['direction'],
  amountMinor: bigint,
  currency = 'NGN',
): PostingLine => ({ accountId, direction, amountMinor, currency });

const wallet: Account = {
  id: 'wallet',
  merchantId: 'm1',
  code: 'wallet',
  currencyCode: 'NGN',
  accountType: 'liability',
  isSystem: false,
  allowNegative: false,
};


describe('validatePosting', () => {
  it('accepts a balanced single-currency posting', () => {
    expect(() =>
      validatePosting({ lines: [line('clearing', 'debit', 500n), line('wallet', 'credit', 500n)] }),
    ).not.toThrow();
  });
;
  it('accepts a split posting (one debit, several credits)', () => {
    expect(() =>
      validatePosting({
        lines: [line('clearing', 'debit', 1000n), line('wallet', 'credit', 985n), line('fees', 'credit', 15n)],
      }),
    ).not.toThrow();
  });

  it('rejects fewer than two lines', () => {
    expect(() => validatePosting({ lines: [line('wallet', 'credit', 500n)] })).toThrow(InvalidPostingError);
  });

  it('rejects zero and negative amounts', () => {
    expect(() =>
      validatePosting({ lines: [line('a', 'debit', 0n), line('b', 'credit', 0n)] }),
    ).toThrow(InvalidAmountError);
    expect(() =>
      validatePosting({ lines: [line('a', 'debit', -5n), line('b', 'credit', -5n)] }),
    ).toThrow(InvalidAmountError);
  });

  it('rejects an unbalanced posting', () => {
    expect(() =>
      validatePosting({ lines: [line('a', 'debit', 500n), line('b', 'credit', 400n)] }),
    ).toThrow(UnbalancedPostingError);
  });

  it('rejects mixed currencies even when the numbers balance', () => {
    expect(() =>
      validatePosting({ lines: [line('a', 'debit', 100n, 'NGN'), line('b', 'credit', 100n, 'USD')] }),
    ).toThrow(CurrencyMismatchError);
  });
});

describe('reversalLines', () => {
  it('flips every direction and keeps accounts and amounts', () => {
    const original = [line('clearing', 'debit', 500n), line('wallet', 'credit', 500n)];
    expect(reversalLines(original)).toEqual([
      line('clearing', 'credit', 500n),
      line('wallet', 'debit', 500n),
    ]);
  });

  it('produces a posting that is itself valid', () => {
    const original = [line('clearing', 'debit', 1000n), line('wallet', 'credit', 985n), line('fees', 'credit', 15n)];
    expect(() => validatePosting({ lines: reversalLines(original) })).not.toThrow();
  });
});

describe('balanceEffect', () => {
  it('credits increase liabilities (merchant wallets) and debits decrease them', () => {
    expect(balanceEffect('liability', 'credit', 500n)).toBe(500n);
    expect(balanceEffect('liability', 'debit', 500n)).toBe(-500n);
  });

  it('debits increase assets', () => {
    expect(balanceEffect('asset', 'debit', 500n)).toBe(500n);
    expect(balanceEffect('asset', 'credit', 500n)).toBe(-500n);
  });
});

describe('netChange', () => {
  it('sums only the lines for that account, signed by account type', () => {
    const lines = [
      line('wallet', 'debit', 800n),
      line('wallet', 'credit', 300n),
      line('clearing', 'credit', 500n),
    ];
    expect(netChange(wallet, lines)).toBe(-500n);
  });
});

describe('balanceOf', () => {
  it('reads a liability as credits minus debits', () => {
    expect(balanceOf('liability', { debits: 200n, credits: 1000n })).toBe(800n);
  });

  it('reads an asset as debits minus credits', () => {
    expect(balanceOf('asset', { debits: 1000n, credits: 200n })).toBe(800n);
  });
});
