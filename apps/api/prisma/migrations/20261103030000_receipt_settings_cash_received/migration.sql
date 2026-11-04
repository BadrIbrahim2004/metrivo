ALTER TABLE public."Tenant"
  ADD COLUMN "receiptDisplayName" TEXT,
  ADD COLUMN "receiptLogoDataUrl" TEXT,
  ADD COLUMN "receiptPhone" TEXT,
  ADD COLUMN "receiptAddress" TEXT,
  ADD COLUMN "receiptFacebook" TEXT,
  ADD COLUMN "receiptInstagram" TEXT;

ALTER TABLE public."Sale"
  ADD COLUMN "cashReceived" DECIMAL(12, 2),
  ADD COLUMN "changeDue" DECIMAL(12, 2);
