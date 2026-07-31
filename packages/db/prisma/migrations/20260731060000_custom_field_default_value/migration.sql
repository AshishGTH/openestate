-- createCustomFieldSchema (packages/shared/src/custom-field.dto.ts) has
-- accepted an optional `defaultValue` since it was written, but no
-- backing column ever existed — CustomFieldsService.create()/update()
-- spread the whole dto into Prisma's `data`, so any real caller sending
-- defaultValue 500'd with "Unknown argument `defaultValue`" instead of
-- getting a clean validation error or a saved value. Found by the
-- through-the-wire master/admin-entity creation e2e test (the first
-- caller to exercise this field via the real HTTP API).

ALTER TABLE "custom_field_definitions" ADD COLUMN "default_value" VARCHAR(500);
