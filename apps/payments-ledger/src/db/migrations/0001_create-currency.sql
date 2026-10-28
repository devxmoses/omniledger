-- Up Migration
CREATE TABLE currency(
    code        CHAR(3)     PRIMARY KEY CHECK (code ~ '^[A-Z]{3}$'),
    exponent    SMALLINT    NOT NULL CHECK (exponent BETWEEN 0 AND 4),
    name        TEXT        NOT NULL
);

INSERT INTO currency (code, exponent,name) VALUES
    ('NGN', 2, 'Nigerian Naira'),
    ('USD', 2, 'US Dollar'),
    ('EUR', 2, 'Euro');

