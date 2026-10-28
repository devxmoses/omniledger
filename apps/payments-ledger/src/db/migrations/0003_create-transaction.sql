-- Up Migration
CREATE TYPE transaction_status AS ENUM('posted', 'reversed');

CREATE TABLE transaction (
    id                              UUID                PRIMARY KEY DEFAULT gen_random_uuid(),
    external_ref                    TEXT,
    idempotency_key                 TEXT                UNIQUE,
    status                          transaction_status  NOT NULL DEFAULT 'posted',
    reverses_transaction_id         UUID                UNIQUE REFERENCES transaction (id),
    created_at                      TIMESTAMPTZ         NOT NULL DEFAULT now(),

    CONSTRAINT transaction_not_self_reversal_chk CHECK (reverses_transaction_id <> id)
);

