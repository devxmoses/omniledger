#!/bin/bash
# Runs once, on first start with an empty data volume.
# One login role and one database per service. Dev-only passwords match the role name.
set -euo pipefail

services=(payments_ledger identity kyc payouts notification reconciliation insights)

for svc in "${services[@]}"; do
    psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<-EOSQL
CREATE ROLE ${svc} LOGIN PASSWORD '${svc}';
CREATE DATABASE ${svc} OWNER ${svc};
REVOKE CONNECT ON DATABASE ${svc} FROM PUBLIC;
EOSQL
done