-- CreateTable
CREATE TABLE "AutoRole" (
    "guildId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "updatedById" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutoRole_pkey" PRIMARY KEY ("guildId")
);
