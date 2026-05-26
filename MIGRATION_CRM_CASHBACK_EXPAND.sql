-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "active" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "avoided_pieces" TEXT,
ADD COLUMN     "birth_date" DATE,
ADD COLUMN     "body_type" TEXT,
ADD COLUMN     "cpf" TEXT,
ADD COLUMN     "favorite_colors" TEXT,
ADD COLUMN     "first_order_at" TIMESTAMP(3),
ADD COLUMN     "gender" TEXT,
ADD COLUMN     "inactive_reason" TEXT,
ADD COLUMN     "last_order_at" TIMESTAMP(3),
ADD COLUMN     "marital_status" TEXT,
ADD COLUMN     "name_social" TEXT,
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "order_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "origin_seller" TEXT,
ADD COLUMN     "origin_source" TEXT,
ADD COLUMN     "origin_store_id" TEXT,
ADD COLUMN     "preferred_style" TEXT,
ADD COLUMN     "referred_by_id" TEXT,
ADD COLUMN     "registro_giga" INTEGER,
ADD COLUMN     "rfv_engagement" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "rfv_segment" TEXT,
ADD COLUMN     "rg" TEXT,
ADD COLUMN     "size_secondary" TEXT,
ADD COLUMN     "ticket_medio_cents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "tier_entered_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "customer_addresses" (
    "id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "cep" TEXT,
    "street" TEXT,
    "number" TEXT,
    "complement" TEXT,
    "district" TEXT,
    "city" TEXT,
    "state" TEXT,
    "reference" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_addresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_consents" (
    "id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "granted" BOOLEAN NOT NULL,
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "term_version" TEXT,
    "source" TEXT,
    "ip_address" TEXT,
    "registered_by_user_id" TEXT,

    CONSTRAINT "customer_consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cashback_balances" (
    "customer_id" TEXT NOT NULL,
    "balance_cents" INTEGER NOT NULL DEFAULT 0,
    "accumulated_total_cents" BIGINT NOT NULL DEFAULT 0,
    "redeemed_total_cents" BIGINT NOT NULL DEFAULT 0,
    "expired_total_cents" BIGINT NOT NULL DEFAULT 0,
    "next_expiration_at" DATE,
    "next_expiration_cents" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cashback_balances_pkey" PRIMARY KEY ("customer_id")
);

-- CreateTable
CREATE TABLE "cashback_transactions" (
    "id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "value_cents" INTEGER NOT NULL,
    "balance_before_cents" INTEGER,
    "balance_after_cents" INTEGER,
    "order_id" TEXT,
    "store_id" TEXT,
    "purchase_value_cents" INTEGER,
    "percent_applied" DECIMAL(5,2),
    "credited_at" DATE,
    "expires_at" DATE,
    "description" TEXT,
    "user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cashback_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tags" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "color" TEXT NOT NULL DEFAULT '#888888',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_tags" (
    "customer_id" TEXT NOT NULL,
    "tag_id" TEXT NOT NULL,
    "applied_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "applied_by" TEXT,

    CONSTRAINT "customer_tags_pkey" PRIMARY KEY ("customer_id","tag_id")
);

-- CreateTable
CREATE TABLE "customer_rfv_snapshots" (
    "id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "snapshot_date" DATE NOT NULL,
    "recency_days" INTEGER NOT NULL,
    "frequency_12m" INTEGER NOT NULL,
    "value_12m_cents" BIGINT NOT NULL,
    "segment" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_rfv_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customer_addresses_customer_id_idx" ON "customer_addresses"("customer_id");

-- CreateIndex
CREATE INDEX "customer_addresses_cep_idx" ON "customer_addresses"("cep");

-- CreateIndex
CREATE INDEX "customer_consents_customer_id_channel_granted_at_idx" ON "customer_consents"("customer_id", "channel", "granted_at");

-- CreateIndex
CREATE INDEX "cashback_transactions_customer_id_created_at_idx" ON "cashback_transactions"("customer_id", "created_at");

-- CreateIndex
CREATE INDEX "cashback_transactions_expires_at_idx" ON "cashback_transactions"("expires_at");

-- CreateIndex
CREATE INDEX "cashback_transactions_type_idx" ON "cashback_transactions"("type");

-- CreateIndex
CREATE UNIQUE INDEX "tags_name_key" ON "tags"("name");

-- CreateIndex
CREATE INDEX "customer_tags_tag_id_idx" ON "customer_tags"("tag_id");

-- CreateIndex
CREATE INDEX "customer_rfv_snapshots_customer_id_snapshot_date_idx" ON "customer_rfv_snapshots"("customer_id", "snapshot_date");

-- CreateIndex
CREATE UNIQUE INDEX "customer_rfv_snapshots_customer_id_snapshot_date_key" ON "customer_rfv_snapshots"("customer_id", "snapshot_date");

-- CreateIndex
CREATE UNIQUE INDEX "customers_cpf_key" ON "customers"("cpf");

-- CreateIndex
CREATE UNIQUE INDEX "customers_registro_giga_key" ON "customers"("registro_giga");

-- CreateIndex
CREATE INDEX "customers_cpf_idx" ON "customers"("cpf");

-- CreateIndex
CREATE INDEX "customers_phone_idx" ON "customers"("phone");

-- CreateIndex
CREATE INDEX "customers_whatsapp_idx" ON "customers"("whatsapp");

-- CreateIndex
CREATE INDEX "customers_vip_tier_idx" ON "customers"("vip_tier");

-- CreateIndex
CREATE INDEX "customers_rfv_segment_idx" ON "customers"("rfv_segment");

-- CreateIndex
CREATE INDEX "customers_origin_store_id_idx" ON "customers"("origin_store_id");

-- CreateIndex
CREATE INDEX "customers_last_order_at_idx" ON "customers"("last_order_at");

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_origin_store_id_fkey" FOREIGN KEY ("origin_store_id") REFERENCES "stores"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_referred_by_id_fkey" FOREIGN KEY ("referred_by_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_addresses" ADD CONSTRAINT "customer_addresses_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_consents" ADD CONSTRAINT "customer_consents_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cashback_balances" ADD CONSTRAINT "cashback_balances_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cashback_transactions" ADD CONSTRAINT "cashback_transactions_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cashback_transactions" ADD CONSTRAINT "cashback_transactions_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_tags" ADD CONSTRAINT "customer_tags_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_tags" ADD CONSTRAINT "customer_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_rfv_snapshots" ADD CONSTRAINT "customer_rfv_snapshots_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

┌─────────────────────────────────────────────────────────┐
│  Update available 5.22.0 -> 7.8.0                       │
│                                                         │
│  This is a major update - please follow the guide at    │
│  https://pris.ly/d/major-version-upgrade                │
│                                                         │
│  Run the following to update                            │
│    npm i --save-dev prisma@latest                       │
│    npm i @prisma/client@latest                          │
└─────────────────────────────────────────────────────────┘
