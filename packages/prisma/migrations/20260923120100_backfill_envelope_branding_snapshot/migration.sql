-- Backfill: pin the branding resolved right now onto every envelope that is
-- still in flight, so artifacts rendered after this migration keep using the
-- same brand version as the ones rendered before it.
--
-- Kept in its own migration on purpose (same split as the SGC backfills): the
-- DDL of 20260923120000 commits first, so a failed backfill can be retried
-- without re-running the schema change.
--
-- The query mirrors `getTeamSettings` + `extractDerivedTeamSettings`
-- (packages/lib/utils/teams.ts): the team value wins per field, the
-- organisation value is used otherwise, and the organisation defaults apply
-- when a settings row is missing. It writes the same shape as
-- `buildEnvelopeBrandingSnapshot`
-- (packages/lib/server-only/envelope/branding-snapshot.ts), which pins the
-- branding for envelopes created from now on.
--
-- Finalised envelopes (COMPLETED/REJECTED/CANCELLED) are deliberately skipped:
-- resolving today's brand for them would record a version the signer never saw.
-- Their readers fall back to live settings, exactly as before this change.

WITH resolved AS (
  SELECT
    e."id" AS envelope_id,
    e."teamId" AS team_id,
    COALESCE(tgs."brandingEnabled", ogs."brandingEnabled", false) AS enabled,
    COALESCE(tgs."brandingLogo", ogs."brandingLogo", '') AS logo,
    COALESCE(tgs."brandingUrl", ogs."brandingUrl", '') AS url,
    COALESCE(tgs."brandingCompanyDetails", ogs."brandingCompanyDetails", '') AS company_details,
    COALESCE(tgs."brandingColors", ogs."brandingColors") AS colors,
    COALESCE(tgs."brandingCss", ogs."brandingCss", '') AS css
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
