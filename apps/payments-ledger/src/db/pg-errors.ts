import { DatabaseError } from "pg";

/** True if `err` is a Postgres error raised by the named constraint (or trigger using CONSTRAINT = ...). */
export function isConstraintViolation(err: unknown, constraint: string): err is DatabaseError{
    return err instanceof DatabaseError && err.constraint === constraint;
}