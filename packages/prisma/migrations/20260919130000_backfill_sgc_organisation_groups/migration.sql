-- Backfill: create the internal SGC organisation group for every existing
-- organisation so the role can be assigned without recreating the organisation.
-- Mirrors the INTERNAL_ORGANISATION groups created by `createOrganisation`.
--
-- Kept in its own migration on purpose: PostgreSQL cannot use a new enum value
-- in the same transaction that added it, and Prisma runs each migration file in
-- a single transaction, so 'SGC' is only usable once 20260919120000 has committed.

INSERT INTO "OrganisationGroup" ("id", "name", "type", "organisationRole", "organisationId")
SELECT 'org_group_sgc_backfill_' || o."id",
       NULL,
       'INTERNAL_ORGANISATION',
       'SGC',
       o."id"
FROM "Organisation" o
WHERE NOT EXISTS (
  SELECT 1
  FROM "OrganisationGroup" og
  WHERE og."organisationId" = o."id"
    AND og."type" = 'INTERNAL_ORGANISATION'
    AND og."organisationRole" = 'SGC'
);

-- Attach the SGC organisation group to every existing team of that organisation
-- with the team SGC role, so organisation SGC members hold the SGC privileges in
-- every team of their organisation. Mirrors the team groups `createTeam` creates
-- for the internal organisation groups.
INSERT INTO "TeamGroup" ("id", "organisationGroupId", "teamRole", "teamId")
SELECT 'team_group_org_sgc_backfill_' || t."id",
       og."id",
       'SGC',
       t."id"
FROM "Team" t
JOIN "OrganisationGroup" og
  ON og."organisationId" = t."organisationId"
 AND og."type" = 'INTERNAL_ORGANISATION'
 AND og."organisationRole" = 'SGC'
WHERE NOT EXISTS (
  SELECT 1
  FROM "TeamGroup" tg
  WHERE tg."teamId" = t."id" AND tg."organisationGroupId" = og."id"
);
