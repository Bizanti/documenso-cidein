-- Backfill: pin the branding resolved right now onto every envelope that is
-- still in flight, so artifacts rendered after this migration keep using the
-- same brand version as the ones rendered before it.
--
-- Kept in its own migration on purpose (same split as the SGC backfills): the
-- DDL of 20260923120000 commits first, so a failed backfill can be retried
-- without re-running the schema change.
--
-- The query mirrors the branding resolution of `getTeamSettings`
-- (packages/lib/server-only/team/get-team-settings.ts:36-46) followed by
-- `extractDerivedTeamSettings` (packages/lib/utils/teams.ts), and writes the
-- same shape as `buildEnvelopeBrandingSnapshot`
-- (packages/lib/server-only/envelope/branding-snapshot.ts), which pins the
-- branding for envelopes created from now on.
--
-- Resolution rules, field by field:
--
-- | team `brandingEnabled` | team field          | resolved value       |
-- | ---------------------- | ------------------- | -------------------- |
-- | NULL (inherits)        | ignored, always     | organisation value   |
-- | set                    | not NULL            | team value           |
-- | set                    | NULL                | organisation value   |
--
-- The first row is the "inherit all" branch: while a team has no explicit
-- `brandingEnabled` it inherits ALL six fields from the organisation, so a team
-- value left over from an earlier state is ignored. That state is reachable —
-- `update-team-branding-logo` writes `brandingLogo` without touching
-- `brandingEnabled` — and resolving it per field would pin the team logo while
-- the signer was being shown the organisation logo.
--
-- Finalised envelopes (COMPLETED/REJECTED/CANCELLED) are deliberately skipped:
-- resolving today's brand for them would record a version the signer never saw.
-- Their readers fall back to live settings, exactly as before this change.

WITH resolved AS (
  SELECT
    e."id" AS envelope_id,
    e."teamId" AS team_id,
    CASE
      WHEN tgs."brandingEnabled" IS NULL THEN COALESCE(ogs."brandingEnabled", false)
      ELSE COALESCE(tgs."brandingEnabled", ogs."brandingEnabled", false)
    END AS enabled,
    CASE
      WHEN tgs."brandingEnabled" IS NULL THEN COALESCE(ogs."brandingLogo", '')
      ELSE COALESCE(tgs."brandingLogo", ogs."brandingLogo", '')
    END AS logo,
    CASE
      WHEN tgs."brandingEnabled" IS NULL THEN COALESCE(ogs."brandingUrl", '')
      ELSE COALESCE(tgs."brandingUrl", ogs."brandingUrl", '')
    END AS url,
    CASE
      WHEN tgs."brandingEnabled" IS NULL THEN COALESCE(ogs."brandingCompanyDetails", '')
      ELSE COALESCE(tgs."brandingCompanyDetails", ogs."brandingCompanyDetails", '')
    END AS company_details,
    CASE
      WHEN tgs."brandingEnabled" IS NULL THEN ogs."brandingColors"
      ELSE COALESCE(tgs."brandingColors", ogs."brandingColors")
    END AS colors,
    CASE
      WHEN tgs."brandingEnabled" IS NULL THEN COALESCE(ogs."brandingCss", '')
      ELSE COALESCE(tgs."brandingCss", ogs."brandingCss", '')
    END AS css
  FROM "Envelope" e
  JOIN "Team" t ON t."id" = e."teamId"
  LEFT JOIN "Organisation" o ON o."id" = t."organisationId"
  LEFT JOIN "OrganisationGlobalSettings" ogs ON ogs."id" = o."organisationGlobalSettingsId"
  LEFT JOIN "TeamGlobalSettings" tgs ON tgs."id" = t."teamGlobalSettingsId"
  WHERE e."brandingSnapshot" IS NULL
    AND e."deletedAt" IS NULL
    AND e."status" NOT IN ('COMPLETED', 'REJECTED', 'CANCELLED')
)
UPDATE "Envelope" e
SET "brandingSnapshot" = jsonb_build_object(
  'version', 1,
  'source', 'backfill',
  'brandId', 'team:' || r.team_id::text,
  'capturedAt', to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'enabled', r.enabled,
  'logo', r.logo,
  'url', r.url,
  'companyDetails', r.company_details,
  'colors', r.colors,
  'css', r.css,
  'logoHash', CASE WHEN r.logo = '' THEN NULL ELSE encode(sha256(convert_to(r.logo, 'UTF8')), 'hex') END,
  'logoVersion', CASE WHEN r.logo = '' THEN NULL ELSE left(encode(sha256(convert_to(r.logo, 'UTF8')), 'hex'), 16) END,
  'brandVersion', encode(sha256(convert_to(jsonb_build_object(
    'enabled', r.enabled,
    'logo', r.logo,
    'url', r.url,
    'companyDetails', r.company_details,
    'colors', r.colors,
    'css', r.css
  )::text, 'UTF8')), 'hex')
)
FROM resolved r
WHERE e."id" = r.envelope_id;
