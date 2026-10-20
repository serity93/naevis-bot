-- CreateTable
CREATE TABLE "ReactionRoleMessage" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "title" TEXT,
    "content" TEXT NOT NULL,
    "color" INTEGER NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReactionRoleMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReactionRoleOption" (
    "id" TEXT NOT NULL,
    "configId" TEXT NOT NULL,
    "emojiKey" TEXT NOT NULL,
    "emojiDisplay" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "ReactionRoleOption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReactionRoleMessage_messageId_key" ON "ReactionRoleMessage"("messageId");

-- CreateIndex
CREATE INDEX "ReactionRoleMessage_guildId_idx" ON "ReactionRoleMessage"("guildId");

-- CreateIndex
CREATE UNIQUE INDEX "ReactionRoleOption_configId_emojiKey_key" ON "ReactionRoleOption"("configId", "emojiKey");

-- CreateIndex
CREATE UNIQUE INDEX "ReactionRoleOption_configId_roleId_key" ON "ReactionRoleOption"("configId", "roleId");

-- AddForeignKey
ALTER TABLE "ReactionRoleOption" ADD CONSTRAINT "ReactionRoleOption_configId_fkey" FOREIGN KEY ("configId") REFERENCES "ReactionRoleMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
