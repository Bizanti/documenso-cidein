-- AlterEnum
ALTER TYPE "TeamMemberRole" ADD VALUE 'SGC';

-- AlterTable
ALTER TABLE "DocumentMeta" ADD COLUMN "downloadWindowHours" INTEGER;

-- Backfill: create the internal SGC team group for every existing team so the
-- role can be assigned without recreating the team. Mirrors the INTERNAL_TEAM
-- groups created by `createTeam` for ADMIN/MANAGER/MEMBER.
INSERT INTO "OrganisationGroup" ("id", "name", "type", "organisationRole", "organisationId")
SELECT 'org_group_sgc_backfill_' || t."id",
       NULL,
       'INTERNAL_TEAM',
       'MEMBER',
       t."organisationId"
FROM "Team" t
WHERE NOT EXISTS (
  SELECT 1
  FROM "TeamGroup" tg
  WHERE tg."teamId" = t."id" AND tg."teamRole" = 'SGC'
);

INSERT INTO "TeamGroup" ("id", "organisationGroupId", "teamRole", "teamId")
SELECT 'team_group_sgc_backfill_' || t."id",
       'org_group_sgc_backfill_' || t."id",
       'SGC',
       t."id"
FROM "Team" t
WHERE NOT EXISTS (
  SELECT 1
  FROM "TeamGroup" tg
  WHERE tg."teamId" = t."id" AND tg."teamRole" = 'SGC'
);
