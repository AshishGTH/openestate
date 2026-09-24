-- v0.8.0: per-field exemption from the Aadhaar value guard (layer c).
-- When true, custom-field values written to this definition skip the
-- 12-digit Verhoeff check — for a field that legitimately holds a
-- 12-digit number, such as a bank account number. Default false: every
-- existing field is checked. Additive; on PostgreSQL 11+ adding a
-- column with a constant default only changes the catalog (no rewrite).
ALTER TABLE "custom_field_definitions" ADD COLUMN "allows_twelve_digit_values" BOOLEAN NOT NULL DEFAULT false;
