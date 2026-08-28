-- Booking.sourceInquiryId (Follow-Up Page spec's Successful -> Booking
-- gap). Scalar + DB-level FK, no Prisma relation — same policy as
-- broker_id/interest_rule_id (see their own ADD COLUMN migrations).
ALTER TABLE "bookings" ADD COLUMN "source_inquiry_id" UUID;

ALTER TABLE "bookings" ADD CONSTRAINT "bookings_source_inquiry_id_fkey"
  FOREIGN KEY ("source_inquiry_id") REFERENCES "inquiries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- One inquiry converts to at most one booking. A plain unique index would
-- already permit unlimited NULLs (Postgres never treats NULL = NULL for
-- uniqueness), but the WHERE clause is written explicitly rather than
-- relied on implicitly — same reasoning, and the same partial-index
-- pattern, as lead_stages_one_default_per_company (lead_stage_foundation
-- migration). Without this, a double-submitted booking-creation request
-- could attach two different bookings to the same inquiry and double-count
-- a conversion in the funnel report; InquiryService.attachBooking() also
-- checks this proactively for a clean error message, but this index is
-- the actual, concurrency-safe enforcement.
CREATE UNIQUE INDEX "bookings_source_inquiry_id_key" ON "bookings"("source_inquiry_id") WHERE "source_inquiry_id" IS NOT NULL;
