-- Google reports whether a subscription will renew; until now that answer only
-- reached us inside the raw verification metadata, so the app could not tell a
-- plan that renews next month from one that ends then.

ALTER TABLE "SubscriptionState"
    ADD COLUMN "autoRenewing" BOOLEAN;
