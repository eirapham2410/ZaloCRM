/*
  Warnings:

  - You are about to drop the `appointments` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[conversation_id,zalo_msg_id]` on the table `messages` will be added. If there are existing duplicate values, this will fail.

*/
-- DropForeignKey
ALTER TABLE "appointments" DROP CONSTRAINT "appointments_assigned_user_id_fkey";

-- DropForeignKey
ALTER TABLE "appointments" DROP CONSTRAINT "appointments_contact_id_fkey";

-- DropForeignKey
ALTER TABLE "appointments" DROP CONSTRAINT "appointments_org_id_fkey";

-- AlterTable
ALTER TABLE "contacts" ADD COLUMN     "is_zalo_friend" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "album_index" INTEGER,
ADD COLUMN     "album_key" TEXT,
ADD COLUMN     "album_total" INTEGER,
ADD COLUMN     "cli_msg_id" TEXT,
ADD COLUMN     "mentions" JSONB,
ADD COLUMN     "quote" JSONB,
ADD COLUMN     "reply_to_message_id" TEXT;

-- AlterTable
ALTER TABLE "zalo_accounts" ADD COLUMN     "proxy_id" TEXT;

-- DropTable
DROP TABLE "appointments";

-- CreateTable
CREATE TABLE "proxies" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "provider" TEXT,
    "max_accounts" INTEGER NOT NULL DEFAULT 5,
    "verified_ip" TEXT,
    "last_checked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "proxies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zalo_friends" (
    "id" TEXT NOT NULL,
    "zalo_account_id" TEXT NOT NULL,
    "zalo_uid" TEXT NOT NULL,
    "display_name" TEXT,
    "avatar_url" TEXT,
    "phone" TEXT,
    "tags" JSONB NOT NULL DEFAULT '[]',
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "zalo_friends_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zalo_groups" (
    "id" TEXT NOT NULL,
    "zalo_account_id" TEXT NOT NULL,
    "zalo_group_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "avatar" TEXT,
    "member_count" INTEGER NOT NULL DEFAULT 0,
    "owner_id" TEXT,
    "role" TEXT NOT NULL DEFAULT 'Member',
    "fingerprint" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "zalo_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saved_reports" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "saved_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_templates" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "owner_user_id" TEXT,
    "name" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "category" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "message_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_configs" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'anthropic',
    "model" TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
    "max_daily" INTEGER NOT NULL DEFAULT 500,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_suggestions" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "message_id" TEXT,
    "type" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "accepted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_suggestions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_reactions" (
    "id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "reactor_id" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_reactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pinned_conversations" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "zalo_account_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "pinned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pinned_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_polls" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "zalo_account_id" TEXT NOT NULL,
    "group_external_id" TEXT NOT NULL,
    "zalo_poll_id" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "options" JSONB NOT NULL DEFAULT '[]',
    "is_multi_choice" BOOLEAN NOT NULL DEFAULT false,
    "is_anonymous" BOOLEAN NOT NULL DEFAULT false,
    "is_locked" BOOLEAN NOT NULL DEFAULT false,
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "group_polls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaigns" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "template_id" TEXT,
    "campaign_type" TEXT NOT NULL DEFAULT 'BULK_MESSAGE',
    "invite_message" TEXT,
    "use_rotation" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "total_recipients" INTEGER NOT NULL DEFAULT 0,
    "sent_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "account_ids" TEXT[],
    "active_hours" JSONB NOT NULL DEFAULT '{"start":"08:00","end":"20:00"}',
    "config" JSONB NOT NULL DEFAULT '{}',
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_recipients" (
    "id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "contact_id" TEXT,
    "phone" TEXT,
    "zalo_uid" TEXT,
    "name" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "recipient_type" TEXT NOT NULL DEFAULT 'stranger',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "used_account_id" TEXT,
    "error_log" TEXT,
    "sent_at" TIMESTAMP(3),

    CONSTRAINT "campaign_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_account_stats" (
    "id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "zalo_account_id" TEXT NOT NULL,
    "sent_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'active',

    CONSTRAINT "campaign_account_stats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blacklists" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "phone" TEXT,
    "zalo_uid" TEXT,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blacklists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_members" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "zalo_uid" TEXT NOT NULL,
    "name" TEXT,
    "avatar" TEXT,
    "role" TEXT NOT NULL DEFAULT 'Member',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "group_members_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "proxies_org_id_url_key" ON "proxies"("org_id", "url");

-- CreateIndex
CREATE INDEX "zalo_friends_zalo_account_id_idx" ON "zalo_friends"("zalo_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "zalo_friends_zalo_account_id_zalo_uid_key" ON "zalo_friends"("zalo_account_id", "zalo_uid");

-- CreateIndex
CREATE INDEX "zalo_groups_zalo_account_id_idx" ON "zalo_groups"("zalo_account_id");

-- CreateIndex
CREATE INDEX "zalo_groups_zalo_account_id_name_idx" ON "zalo_groups"("zalo_account_id", "name");

-- CreateIndex
CREATE INDEX "zalo_groups_fingerprint_idx" ON "zalo_groups"("fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "zalo_groups_zalo_account_id_zalo_group_id_key" ON "zalo_groups"("zalo_account_id", "zalo_group_id");

-- CreateIndex
CREATE INDEX "message_templates_org_id_owner_user_id_idx" ON "message_templates"("org_id", "owner_user_id");

-- CreateIndex
CREATE INDEX "message_templates_org_id_category_idx" ON "message_templates"("org_id", "category");

-- CreateIndex
CREATE UNIQUE INDEX "ai_configs_org_id_key" ON "ai_configs"("org_id");

-- CreateIndex
CREATE INDEX "ai_suggestions_org_id_created_at_idx" ON "ai_suggestions"("org_id", "created_at");

-- CreateIndex
CREATE INDEX "ai_suggestions_conversation_id_created_at_idx" ON "ai_suggestions"("conversation_id", "created_at");

-- CreateIndex
CREATE INDEX "ai_suggestions_org_id_type_created_at_idx" ON "ai_suggestions"("org_id", "type", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "message_reactions_message_id_reactor_id_key" ON "message_reactions"("message_id", "reactor_id");

-- CreateIndex
CREATE UNIQUE INDEX "pinned_conversations_zalo_account_id_conversation_id_key" ON "pinned_conversations"("zalo_account_id", "conversation_id");

-- CreateIndex
CREATE INDEX "group_polls_org_id_group_external_id_idx" ON "group_polls"("org_id", "group_external_id");

-- CreateIndex
CREATE UNIQUE INDEX "group_polls_zalo_account_id_zalo_poll_id_key" ON "group_polls"("zalo_account_id", "zalo_poll_id");

-- CreateIndex
CREATE INDEX "campaigns_org_id_status_idx" ON "campaigns"("org_id", "status");

-- CreateIndex
CREATE INDEX "campaign_recipients_campaign_id_status_recipient_type_idx" ON "campaign_recipients"("campaign_id", "status", "recipient_type");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_account_stats_campaign_id_zalo_account_id_key" ON "campaign_account_stats"("campaign_id", "zalo_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "blacklists_org_id_phone_key" ON "blacklists"("org_id", "phone");

-- CreateIndex
CREATE UNIQUE INDEX "blacklists_org_id_zalo_uid_key" ON "blacklists"("org_id", "zalo_uid");

-- CreateIndex
CREATE INDEX "group_members_org_id_group_id_idx" ON "group_members"("org_id", "group_id");

-- CreateIndex
CREATE UNIQUE INDEX "group_members_group_id_zalo_uid_key" ON "group_members"("group_id", "zalo_uid");

-- CreateIndex
CREATE INDEX "conversations_org_id_zalo_account_id_is_replied_last_messag_idx" ON "conversations"("org_id", "zalo_account_id", "is_replied", "last_message_at");

-- CreateIndex
CREATE INDEX "conversations_org_id_zalo_account_id_last_message_at_idx" ON "conversations"("org_id", "zalo_account_id", "last_message_at");

-- CreateIndex
CREATE INDEX "messages_conversation_id_album_key_idx" ON "messages"("conversation_id", "album_key");

-- CreateIndex
CREATE INDEX "messages_reply_to_message_id_idx" ON "messages"("reply_to_message_id");

-- CreateIndex
CREATE UNIQUE INDEX "messages_conversation_id_zalo_msg_id_key" ON "messages"("conversation_id", "zalo_msg_id");

-- AddForeignKey
ALTER TABLE "proxies" ADD CONSTRAINT "proxies_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zalo_accounts" ADD CONSTRAINT "zalo_accounts_proxy_id_fkey" FOREIGN KEY ("proxy_id") REFERENCES "proxies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zalo_friends" ADD CONSTRAINT "zalo_friends_zalo_account_id_fkey" FOREIGN KEY ("zalo_account_id") REFERENCES "zalo_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zalo_groups" ADD CONSTRAINT "zalo_groups_zalo_account_id_fkey" FOREIGN KEY ("zalo_account_id") REFERENCES "zalo_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_reply_to_message_id_fkey" FOREIGN KEY ("reply_to_message_id") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_reports" ADD CONSTRAINT "saved_reports_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_configs" ADD CONSTRAINT "ai_configs_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_suggestions" ADD CONSTRAINT "ai_suggestions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_suggestions" ADD CONSTRAINT "ai_suggestions_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pinned_conversations" ADD CONSTRAINT "pinned_conversations_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pinned_conversations" ADD CONSTRAINT "pinned_conversations_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_polls" ADD CONSTRAINT "group_polls_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "message_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_used_account_id_fkey" FOREIGN KEY ("used_account_id") REFERENCES "zalo_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_account_stats" ADD CONSTRAINT "campaign_account_stats_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_account_stats" ADD CONSTRAINT "campaign_account_stats_zalo_account_id_fkey" FOREIGN KEY ("zalo_account_id") REFERENCES "zalo_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blacklists" ADD CONSTRAINT "blacklists_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "zalo_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
