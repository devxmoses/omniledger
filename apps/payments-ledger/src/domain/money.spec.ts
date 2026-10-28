import { CurrencyMismatchError, InvalidAmountError } from './errors';
import { add, money, subtract, toMajor, toMinor } from './money';

const NGN = { code: 'NGN', exponent: 2 };
const JPY = { code: 'JPY', exponent: 0 };

describe('toMinor', () => {
  it.each([
    ['12.50', NGN, 1250n],
    ['12.5', NGN, 1250n],
    ['12', NGN, 1200n],
    ['0.01', NGN, 1n],
    ['1.005', { code: 'TST', exponent: 3 }, 1005n],
    ['500', JPY, 500n],
    ['92233720368547758.07', NGN, 9223372036854775807n], // Postgres BIGINT max
  ])('parses %s', (major, currency, expected) => {
    expect(toMinor(major, currency)).toBe(expected);
  });

  it.each(['', 'abc', '-5', '1e3', '1,000', '.5', '12.'])('rejects %p', (major) => {
    expect(() => toMinor(major, NGN)).toThrow(InvalidAmountError);
  });

  it('rejects more decimals than the currency allows', () => {
    expect(() => toMinor('12.505', NGN)).toThrow(InvalidAmountError);
    expect(() => toMinor('1.5', JPY)).toThrow(InvalidAmountError);
  });
});

describe('toMajor', () => {
  it.each([
    [1250n, NGN, '12.50'],
    [5n, NGN, '0.05'],
    [0n, NGN, '0.00'],
    [-1250n, NGN, '-12.50'],
    [500n, JPY, '500'],
  ])('formats %s', (minor, currency, expected) => {
    expect(toMajor(minor, currency)).toBe(expected);
  });

  it('round-trips with toMinor', () => {
    for (const s of ['0.00', '0.01', '1.10', '123456789.99']) {
      expect(toMajor(toMinor(s, NGN), NGN)).toBe(s);
    }
  });
});

describe('add', () => {
  it('adds same-currency amounts exactly', () => {
    expect(add(money(10n, 'NGN'), money(20n, 'NGN'))).toEqual(money(30n, 'NGN'));
  });

  it('refuses to mix currencies', () => {
    expect(() => add(money(10n, 'NGN'), money(10n, 'USD'))).toThrow(CurrencyMismatchError);
  });
});

describe('subtract', () => {
  it('subtracts same-currency amounts exactly', () => {
    expect(subtract(money(30n, 'NGN'), money(10n, 'NGN'))).toEqual(money(20n, 'NGN'));
  });

  it('can go negative', () => {
    expect(subtract(money(10n, 'NGN'), money(30n, 'NGN'))).toEqual(money(-20n, 'NGN'));
  });

  it('refuses to mix currencies', () => {
    expect(() => subtract(money(10n, 'NGN'), money(10n, 'USD'))).toThrow(CurrencyMismatchError);
  });
});
