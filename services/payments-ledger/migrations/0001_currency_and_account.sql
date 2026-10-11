-- ISO 4217 currencies. exponent = number of minor-unit decimal places.
CREATE TABLE currency (
    code CHAR(3) PRIMARY KEY CHECK (code ~ '^[A-Z]{3}$'),
    exponent SMALLINT NOT NULL CHECK (exponent BETWEEN 0 AND 4),
    name TEXT NOT NULL
);

INSERT INTO CURRENCY (code, exponent, name) VALUES
 ('NGN', 2, 'Nigerian Naira'),
 ('USD', 2, 'US Dollar'),
 ('EUR', 2, 'Euro');

 CREATE TYPE account_type AS ENUM ('asset', 'liability', 'revenue', 'expense');

 -- Chart of Accounts. Every account holds exactly one curency.

 CREATE TABLE account (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID,
    currency_code CHAR(3) NOT NULL REFERENCES currency (code),
    account_type account_type NOT NULL,
    purpose TEXT NOT NULL,
    is_system BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFaULT now(),

    CONSTRAINT account_id_currency_unique UNIQUE (id, currency_code),

    CONSTRAINT account_owner_matches_kind CHECK (is_system = (merchant_id IS NULL)),

    CONSTRAINT account_unique_purpose UNIQUE NULLS NOT DISTINCT (merchant_id, currency_code, purpose)
);

