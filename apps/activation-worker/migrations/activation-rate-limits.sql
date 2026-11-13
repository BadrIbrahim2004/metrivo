CREATE TABLE IF NOT EXISTS "LocalActivationRateLimit" (
    "scope" VARCHAR(16) NOT NULL,
    "keyHash" CHAR(64) NOT NULL,
    "windowStartedAt" TIMESTAMPTZ(6) NOT NULL,
    "requestCount" INTEGER NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "LocalActivationRateLimit_pkey"
        PRIMARY KEY ("scope", "keyHash", "windowStartedAt")
);

CREATE INDEX IF NOT EXISTS "LocalActivationRateLimit_expiresAt_idx"
    ON "LocalActivationRateLimit"("expiresAt");
