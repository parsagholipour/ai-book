-- The operator console's sign-in generation (apps/api/src/auth.ts). One row,
-- keyed `console`; no row is generation 0. A console cookie carries the
-- generation it was issued under, and "sign out everywhere" moves it on, which
-- refuses every cookie issued before. A new, empty table: nothing else reads or
-- writes it, so it locks nothing in use.
CREATE TABLE "OperatorSessionEpoch" (
    "key" TEXT NOT NULL,
    "epoch" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OperatorSessionEpoch_pkey" PRIMARY KEY ("key")
);
