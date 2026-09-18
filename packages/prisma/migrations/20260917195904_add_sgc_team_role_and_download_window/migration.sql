-- AlterEnum
ALTER TYPE "TeamMemberRole" ADD VALUE 'SGC';

-- AlterTable
ALTER TABLE "DocumentMeta" ADD COLUMN "downloadWindowHours" INTEGER;
