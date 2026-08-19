-- Reuse detection needs to distinguish a benign re-presentation of a
-- just-consumed refresh token (an aborted page load, a browser restoring
-- several tabs, a lost response) from a genuine replay. That is purely a
-- question of how long ago the token was consumed, which a bare boolean
-- cannot answer — hence a timestamp alongside it.
--
-- Deliberately NOT backfilled: every existing revoked row keeps
-- revoked_at = NULL, which TokenService treats as "infinitely long ago"
-- and therefore outside any grace window. Those rows take the existing
-- revoke-the-family path, which is the safe default — inventing a
-- timestamp for them would hand a grace window to tokens whose real
-- consumption time is unknown.
ALTER TABLE "refresh_tokens" ADD COLUMN "revoked_at" TIMESTAMP(3);

-- The grace path looks up "the live token in this family"; without this
-- the lookup is a seq scan on every refresh once the table is large.
CREATE INDEX "refresh_tokens_family_is_revoked_idx" ON "refresh_tokens"("family", "is_revoked");
