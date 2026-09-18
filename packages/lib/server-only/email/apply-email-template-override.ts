import { renderCustomEmailTemplate } from '../../utils/render-custom-email-template';

export type EmailTemplateOverrideInput = {
  subject?: string;
  body?: string;
};

export type ApplyEmailTemplateOverrideOptions = {
  subject: string;
  body: string;
  override?: EmailTemplateOverrideInput | null;
  variables: Record<string, string>;
};

export type AppliedEmailTemplateOverride = {
  subject: string;
  body: string;
  hasSubjectOverride: boolean;
  hasBodyOverride: boolean;
};

/**
 * Merges an admin-defined email template override into the default subject/body.
 *
 * A blank override field falls back to the default for that field, so subject
 * and body can be overridden independently. Override values are rendered
 * against the provided `{variable}` placeholders (e.g. `{documentName}`).
 */
export const applyEmailTemplateOverride = ({
  subject,
  body,
  override,
  variables,
}: ApplyEmailTemplateOverrideOptions): AppliedEmailTemplateOverride => {
  const hasSubjectOverride = Boolean(override?.subject?.trim());
  const hasBodyOverride = Boolean(override?.body?.trim());

  return {
    subject: hasSubjectOverride ? renderCustomEmailTemplate(override?.subject ?? '', variables) : subject,
    body: hasBodyOverride ? renderCustomEmailTemplate(override?.body ?? '', variables) : body,
    hasSubjectOverride,
    hasBodyOverride,
  };
};
