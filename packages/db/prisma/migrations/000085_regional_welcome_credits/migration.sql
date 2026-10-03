-- Existing pending grants use the configured fallback; settled grants keep their amount.
ALTER TABLE "WelcomeCreditGrant" ADD COLUMN "countryCode" VARCHAR(2);
