-- Up Migration

--- 1. Balanced and single-currency: checked at COMMIT, after all entries exist.
CREATE FUNCTION check_transaction_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_currencies int;
    v_debits     numeric;
    v_credits    numeric;
BEGIN
    SELECT count(DISTINCT currency_code),
            coalesce(sum(amount_minor) FILTER (WHERE direction = 'debit'),0),
            coalesce(sum(amount_minor) FILTER (WHERE direction = 'credit'),0)
    INTO v_currencies, v_debits, v_credits
    FROM journal_entry
    WHERE transaction_id = NEW.transaction_id;

    IF v_currencies > 1 THEN
        RAISE EXCEPTION 'transaction % mixes currencies', NEW.transaction_id
            USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_entry_single_currency';
    END IF;

    IF v_debits <> v_credits THEN
        RAISE EXCEPTION 'transaction % is unbalanced: debits % <> credits %',
                            NEW.transaction_id, v_debits, v_credits
        USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_entry_balanced';
    END IF;

    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER journal_entry_balanced
    AFTER INSERT ON journal_entry
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION check_transaction_balanced();


--- A transaction must have journal entries by COMMIT
CREATE FUNCTION check_transaction_has_entries() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS(SELECT 1 FROM journal_entry WHERE transaction_id = NEW.id) THEN
        RAISE EXCEPTION 'transaction % has no journal entries', NEW.id
            USING ERRCODE = 'check_violation', CONSTRAINT = 'transaction_has_entries';
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER transaction_has_entries
    AFTER INSERT ON transaction
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION check_transaction_has_entries();

--immutable journal, no update, delete or truncate, only append
CREATE FUNCTION forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
        USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER journal_entry_no_update_delete
    BEFORE UPDATE OR DELETE on journal_entry
    FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER journal_entry_no_truncate
    BEFORE TRUNCATE ON journal_entry
    FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER transaction_no_delete
    BEFORE DELETE ON transaction
    FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER transaction_no_truncate
    BEFORE TRUNCATE ON transaction
    FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();


--immutable transaction, never deleted, only change of status
CREATE FUNCTION guard_transaction_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF(to_jsonb(NEW) - 'status')<> (to_jsonb(OLD) - 'status') THEN
        RAISE EXCEPTION 'transaction %: only the status can be changed', OLD.id
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.status <> OLD.status AND NOT (OLD.status = 'posted' AND NEW.status = 'reversed') THEN
        RAISE EXCEPTION 'transaction %: illegal status change % -> %', OLD.id, OLD.status, NEW.status
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER transaction_guard_update
    BEFORE UPDATE ON transaction
    FOR EACH ROW EXECUTE FUNCTION guard_transaction_update();
            