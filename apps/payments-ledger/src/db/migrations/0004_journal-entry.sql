-- Up Migration
CREATE TYPE entry_direction AS ENUM ('debit', 'credit');

CREATE TABLE journal_entry (
    id              BIGINT          GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    transaction_id  UUID            NOT NULL REFERENCES transaction (id),
    account_id      UUID            NOT NULL,
    direction       entry_direction NOT NULL,
    amount_minor    BIGINT          NOT NULL CHECK (amount_minor > 0),
    currency_code   CHAR(3)         NOT NULL,
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT now(),

    CONSTRAINT journal_entry_account_currency_fk
        FOREIGN KEY (account_id, currency_code) REFERENCES account (id, currency_code)

);

CREATE INDEX journal_entry_transaction_id_idx ON journal_entry (transaction_id);
CREATE INDEX journal_entry_account_id_idx     ON journal_entry (account_id,id);