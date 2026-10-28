import { CurrencyMismatchError, InvalidAmountError } from "./errors";

export type CurrencyCode = string;

export interface Currency{
    readonly code: CurrencyCode;
    readonly exponent: number;
}

export interface Money {
    readonly amountMinor: bigint;
    readonly currency: CurrencyCode;
}

export function money(amountMinor:bigint, currency: CurrencyCode): Money{
    return { amountMinor, currency};
}

export function currency(code: CurrencyCode, exponent: number): Currency{
    return {code, exponent};
}

const MAJOR_AMOUNT = /^(\d+)(?:\.(\d+))?$/;

/**
 * "12.50" in NGN (exponent 2) -> 1250n.
 * Works on the string's digits so the value never passes through a float.
 */

export function toMinor(major: string, currency: Currency): bigint {
    const match = MAJOR_AMOUNT.exec(major);
    if(!match) {
        throw new InvalidAmountError(`not a valid amount: "${major}"`);
    }
    const [, whole, fraction = ''] = match;
    if(fraction.length > currency.exponent){
        throw new InvalidAmountError(
            `${currency.code} allows at most ${currency.exponent} decimal places: "${major}"`
        );
    }
    return BigInt(whole + fraction.padEnd(currency.exponent,'0'));
}

/** 1250n in NGN -> "12.50". Inverse of toMinor. */
export function toMajor(amountMinor: bigint, currency: Currency): string{
    const negative = amountMinor < 0n;
    const digits = (negative ? -amountMinor: amountMinor)
        .toString()
        .padStart(currency.exponent + 1, '0');
    const split = digits.length - currency.exponent;
    const whole = digits.slice(0, split);
    const fraction = digits.slice(split);
    return (negative ? '-' : '') + (fraction ? `${whole}.${fraction}`: whole);
}

export function add(a: Money, b: Money): Money{
    assertSameCurrency(a,b);
    return money(a.amountMinor + b.amountMinor, a.currency);
}

export function subtract(a: Money, b: Money): Money{
    assertSameCurrency(a,b);
    return money(a.amountMinor - b.amountMinor, a.currency);
}

function assertSameCurrency(a: Money, b: Money): void{
    if(a.currency !== b.currency) {
        throw new CurrencyMismatchError(`cannot combine ${a.currency} with ${b.currency}`);
    }
}
