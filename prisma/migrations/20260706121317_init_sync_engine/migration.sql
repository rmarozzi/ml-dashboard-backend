/*
  Warnings:

  - A unique constraint covering the columns `[mlPaymentId]` on the table `Payment` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "ChannelType" AS ENUM ('MERCADO_LIVRE', 'SHOPEE');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('RUNNING', 'SUCCESS', 'PARTIAL', 'FAILED');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "buyerCity" TEXT,
ADD COLUMN     "buyerDocNumber" TEXT,
ADD COLUMN     "buyerDocType" TEXT,
ADD COLUMN     "buyerName" TEXT,
ADD COLUMN     "buyerState" TEXT,
ADD COLUMN     "packId" TEXT;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "moneyReleaseDate" TIMESTAMP(3),
ADD COLUMN     "paymentMethodId" TEXT;

-- AlterTable
ALTER TABLE "ProductCost" ADD COLUMN     "cest" TEXT,
ADD COLUMN     "codFabricante" TEXT,
ADD COLUMN     "ean" TEXT,
ADD COLUMN     "marca" TEXT,
ADD COLUMN     "ncm" TEXT;

-- AlterTable
ALTER TABLE "Token" ADD COLUMN     "initialSyncDone" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lastSyncAt" TIMESTAMP(3),
ADD COLUMN     "syncStartedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ChannelAccount" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "channelType" "ChannelType" NOT NULL,
    "externalAccountId" TEXT NOT NULL,
    "accessTokenEnc" TEXT NOT NULL,
    "refreshTokenEnc" TEXT NOT NULL,
    "tokenExpiresAt" TIMESTAMP(3) NOT NULL,
    "apelido" TEXT,
    "externalNickname" TEXT,
    "initialSyncDone" BOOLEAN NOT NULL DEFAULT false,
    "lastSyncAt" TIMESTAMP(3),
    "lastSyncCursor" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncExecutionLog" (
    "id" TEXT NOT NULL,
    "channelAccountId" TEXT NOT NULL,
    "tier" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "windowStart" TIMESTAMP(3),
    "windowEnd" TIMESTAMP(3),
    "ordersFound" INTEGER NOT NULL DEFAULT 0,
    "ordersUpserted" INTEGER NOT NULL DEFAULT 0,
    "status" "SyncStatus" NOT NULL DEFAULT 'RUNNING',
    "errorDetail" TEXT,

    CONSTRAINT "SyncExecutionLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxSetting" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "rate" DOUBLE PRECISION NOT NULL,
    "validFrom" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaxSetting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChannelAccount_userId_channelType_idx" ON "ChannelAccount"("userId", "channelType");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelAccount_userId_channelType_externalAccountId_key" ON "ChannelAccount"("userId", "channelType", "externalAccountId");

-- CreateIndex
CREATE INDEX "SyncExecutionLog_channelAccountId_tier_startedAt_idx" ON "SyncExecutionLog"("channelAccountId", "tier", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_mlPaymentId_key" ON "Payment"("mlPaymentId");

-- AddForeignKey
ALTER TABLE "ChannelAccount" ADD CONSTRAINT "ChannelAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncExecutionLog" ADD CONSTRAINT "SyncExecutionLog_channelAccountId_fkey" FOREIGN KEY ("channelAccountId") REFERENCES "ChannelAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxSetting" ADD CONSTRAINT "TaxSetting_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
