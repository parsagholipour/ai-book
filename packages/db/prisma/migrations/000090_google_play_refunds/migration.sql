CREATE TABLE "GooglePlayRefund" (
    "purchaseTokenHash" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "productType" INTEGER NOT NULL,
    "refundableQuantity" INTEGER NOT NULL DEFAULT 0,
    "quantity" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "GooglePlayRefund_pkey" PRIMARY KEY ("purchaseTokenHash", "orderId"),
    CONSTRAINT "GooglePlayRefund_quantity_check" CHECK (
      "refundableQuantity" >= 0 AND
      ("quantity" IS NULL OR ("quantity" > 0 AND "refundableQuantity" <= "quantity"))
    ),
    CONSTRAINT "GooglePlayRefund_productType_check" CHECK ("productType" IN (1, 2))
);
