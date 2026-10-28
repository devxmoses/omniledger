-- Up Migration
CREATE TYPE account_type AS ENUM ('asset', 'liability','revenue', 'expense');

CREATE TABLE account (
    id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id     UUID,
    code            TEXT            NOT NULL,
    currency_code   CHAR(3)         NOT NULL REFERENCES currency(code),
    account_type    account_type    NOT NULL,
    is_system       BOOLEAN         NOT NULL DEFAULT false, 
    allow_negative  BOOLEAN         NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT now(),

    -- System accounts have no merchant; merchant accounts must have merchant_id.
    CONSTRAINT account_owner_chk CHECK (is_system = (merchant_id IS NULL)),

    -- One wallet/holding/etc per merchant per currency.
    CONSTRAINT account_code_uq UNIQUE NULLS NOT DISTINCT (merchant_id, currency_code,code),

    CONSTRAINT account_id_currency_uq UNIQUE(id, currency_code)
);

 

