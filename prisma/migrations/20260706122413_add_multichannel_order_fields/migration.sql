/*
  Warnings:

  - A unique constraint covering the columns `[externalOrderId]` on the table `Order` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[externalPaymentId]` on the table `Payment` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `externalOrderId` to the `Order` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "Order" DROP CONSTRAINT "Order_tokenId_fkey";

-- DropIndex
DROP INDEX "Order_mlId_key";

-- DropIndex
DROP INDEX "Payment_mlPaymentId_key";

-- AlterTable
ALTER TABLE "Item" ADD COLUMN     "externalItemId" TEXT;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "channelAccountId" TEXT,
ADD COLUMN     "channelType" "ChannelType" DEFAULT 'MERCADO_LIVRE',
ADD COLUMN     "dateLastUpdated" TIMESTAMP(3),
ADD COLUMN     "externalOrderId" TEXT NOT NULL,
ALTER COLUMN "mlId" DROP NOT NULL,
ALTER COLUMN "tokenId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "externalPaymentId" TEXT;

-- AlterTable
ALTER TABLE "Shipment" ADD COLUMN     "externalShipmentId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Order_externalOrderId_key" ON "Order"("externalOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_externalPaymentId_key" ON "Payment"("externalPaymentId");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "Token"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_channelAccountId_fkey" FOREIGN KEY ("channelAccountId") REFERENCES "ChannelAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
