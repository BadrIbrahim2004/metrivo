ALTER TABLE public."Sale"
  DROP CONSTRAINT "Sale_discount_not_above_subtotal",
  DROP CONSTRAINT "Sale_total_matches_amounts";

ALTER TABLE public."Sale"
  ADD COLUMN surcharge NUMERIC(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN "customerName" VARCHAR(120),
  ADD COLUMN "adjustmentReason" VARCHAR(200);

ALTER TABLE public."Sale"
  ADD CONSTRAINT "Sale_surcharge_nonnegative" CHECK (surcharge >= 0),
  ADD CONSTRAINT "Sale_one_adjustment_type"
    CHECK (discount = 0 OR surcharge = 0),
  ADD CONSTRAINT "Sale_discount_not_above_subtotal" CHECK (discount <= subtotal),
  ADD CONSTRAINT "Sale_total_matches_amounts"
    CHECK (total = subtotal - discount + surcharge);
