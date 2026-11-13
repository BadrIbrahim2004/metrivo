CREATE TABLE "LocalActivationChallenge" (
    "id" VARCHAR(36) NOT NULL,
    "deviceId" VARCHAR(43) NOT NULL,
    "codeHash" CHAR(64) NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "consumedAt" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LocalActivationChallenge_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LocalActivationChallenge_deviceId_createdAt_idx"
    ON "LocalActivationChallenge"("deviceId", "createdAt");
CREATE INDEX "LocalActivationChallenge_expiresAt_idx"
    ON "LocalActivationChallenge"("expiresAt");
