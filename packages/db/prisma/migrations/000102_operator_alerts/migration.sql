-- The API's operator alert sweep (apps/api/src/monitoring/operatorAlerts.ts).
-- One row per alert condition — firing, whether the owner was emailed, the
-- consecutive failing/passing sweeps behind that — so a restart neither sends
-- an alert twice nor forgets the recovery it owes. The `sweep` row is the
-- claim that makes one API process the sender per interval. A new, empty
-- table: nothing else reads or writes it, so it locks nothing in use.
CREATE TABLE "OperatorAlert" (
    "key" TEXT NOT NULL,
    "firing" BOOLEAN NOT NULL DEFAULT false,
    "notified" BOOLEAN NOT NULL DEFAULT false,
    "failingSweeps" INTEGER NOT NULL DEFAULT 0,
    "passingSweeps" INTEGER NOT NULL DEFAULT 0,
    "detail" TEXT,
    "firingSince" TIMESTAMP(3),
    "lastFiredAt" TIMESTAMP(3),
    "lastRecoveredAt" TIMESTAMP(3),
    "observedAt" TIMESTAMP(3),
    "claimedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OperatorAlert_pkey" PRIMARY KEY ("key")
);
