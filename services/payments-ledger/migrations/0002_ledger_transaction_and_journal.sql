--the ledger transaction itself has no amounts, all amounts are in the journal_entry
-- which is the entry for the ledger_transaction

CREATE TABLE ledger_transaction (
    id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    description             TEXT       NOT NULL,
    external_ref            TEXT,
    idempotency_key        TEXT       UNIQUE,
    --- its an immutable ledger, so any correction creates a new transaction which is the reverse transaction
    reverses_transaction_id UUID       UNIQUE REFERENCES ledger_transaction(id),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TYPE entry_direction AS ENUM('debit', 'credit');

CREATE TABLE journal_entry (
    id              BIGINT          GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    transaction_id  UUID            NOT NULL REFERENCES ledger_transaction(id),
    account_id      UUID            NOT NULL,
    direction       entry_directon  NOT NULL,
    amount_minor    BIGINT          NOT NULL CHECK (amount_minor > 0),
    currency_code   CHAR(3)         NOT NULL,
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT now(),

    CONSTRAINT journal_entry_account_currency_fk
        FOREIGN KEY (account_id, currency_code) REFERENCES account (id, currency_code)
);

CREATE INDEX journal_entry_transaction_tx ON journal_entry(transaction_id);
CREATE INDEX journal_entry_account_idx ON journal_entry(account_id, id);

------ Invariant 1: Every transaction balances, in exactly one currency
-- asin for the NGN account we make sure debit and credit sides of the journal_entry is balanced
---then for the USD account, same thing

CREATE FUNCTION assert_transaction_balanced(tx_id UUID) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    entry_count INT;
    currency_count INT;
    net NUMERIC;
BEGIN
    SELECT count(*),
            count(DISTINCT currency_code),
            coalesce(SUM(CASE direction WHEN 'debit' THEN amount_minor ELSE -amount_minor END),0)
    INTO entry_count, currency_count, net
    FROM journal_entry
    WHERE transaction_id = tx_id;

    IF entry_count < 2 THEN
        RAISE EXCEPTION 'ledger transaction % has % entries; at least 2 required', tx_id, entry_count
        USING ERRCODE = 'check_violation';
    END IF;
    IF currency_count > 1 THEN
        RAISE EXCEPTION 'ledger transaction % mixes currencies', tx_id
            USING ERRCODE = 'check_violation';
    END IF;
    IF net <> 0 THEN
        RAISE EXCEPTION 'ledger transaction % is unbalanced: debits - credits = %', tx_id, net
            USING ERRCODE = 'check_violation';
    END IF;
END $$;

CREATE FUNCTION journal_entry_balanced_trg() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM assert_transaction_balanced(NEW.transaction_id);
    RETURN NULL;
END $$;

CREATE FUNCTION ledger_transaction_balanced_trg() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM assert_transaction_balanced(NEW.id);
    RETURN NULL;
END $$;

--DEFERRED: checked at COMMIT, after all entries are in, not after each row.
-- you have created the functions above, now when there is a trigger, it executes the function
-- you initially defer it so that when there is an entry it doesent run yet, 
-- then you execute it after reach row, this row shows when the transaction set is complete
--- because they are all in a single transaction, which has all entries, so we deferred it initaly
-- so that it doesent run after each entry

CREATE CONSTRAINT TRIGGER journal_entry_balanced
    AFTER INSERT ON journal_entry
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION journal_entry_balanced_trg();

CREATE CONSTRAINT TRIGGER ledger_transaction_balanced
    AFTER INSERT ON ledger_transaction
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION ledger_transaction_balanced_trg();



---Invariant 2: the ledger is append-only i.e immutable and rejects any change

CREATE FUNCTION reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END $$;

CREATE TRIGGER journal_entry_append_only
    BEFORE UPDATE OR DELETE ON journal_entry
    FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER journal_entry_no_truncate
    BEFORE TRUNCATE ON journal_entry
    FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER ledger_transaction_append_only
    BEFORE UPDATE OR DELETE ON ledger_transaction
    FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER ledger_transaction_no_truncate
    BEFORE TRUNCATE ON ledger_transaction
    FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();




