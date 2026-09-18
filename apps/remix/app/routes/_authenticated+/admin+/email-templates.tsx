import { getSiteSettings } from '@documenso/lib/server-only/site-settings/get-site-settings';
import {
  EMAIL_TEMPLATE_IDS,
  SITE_SETTINGS_EMAIL_TEMPLATES_ID,
  type TEmailTemplateId,
  type TSiteSettingsEmailTemplatesSchema,
} from '@documenso/lib/server-only/site-settings/schemas/email-templates';
import { trpc as trpcReact } from '@documenso/trpc/react';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@documenso/ui/primitives/accordion';
import { Badge } from '@documenso/ui/primitives/badge';
import { Button } from '@documenso/ui/primitives/button';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@documenso/ui/primitives/form/form';
import { Input } from '@documenso/ui/primitives/input';
import { Switch } from '@documenso/ui/primitives/switch';
import { Textarea } from '@documenso/ui/primitives/textarea';
import { useToast } from '@documenso/ui/primitives/use-toast';
import { zodResolver } from '@hookform/resolvers/zod';
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { useForm } from 'react-hook-form';
import { useRevalidator } from 'react-router';
import { z } from 'zod';

import { SettingsHeader } from '~/components/general/settings-header';
import { appMetaTags } from '~/utils/meta';
import type { Route } from './+types/email-templates';

export function meta() {
  return appMetaTags(msg`Email Templates`);
}

export async function loader() {
  const settings = await getSiteSettings();

  const emailTemplates = settings.find((setting) => setting.id === SITE_SETTINGS_EMAIL_TEMPLATES_ID);

  return { emailTemplates: emailTemplates ?? null };
}

export default function AdminEmailTemplatesPage({ loaderData }: Route.ComponentProps) {
  const { emailTemplates } = loaderData;

  const { _ } = useLingui();
  const { toast } = useToast();
  const { revalidate } = useRevalidator();

  const enabled = emailTemplates?.enabled ?? false;
  const templates = emailTemplates?.data?.templates ?? {};

  const { mutateAsync: updateSiteSetting, isPending: isUpdateSiteSettingLoading } =
    trpcReact.admin.updateSiteSetting.useMutation();

  const persistTemplates = async (nextEnabled: boolean, nextTemplates: typeof templates) => {
    await updateSiteSetting({
      id: SITE_SETTINGS_EMAIL_TEMPLATES_ID,
      enabled: nextEnabled,
      data: {
        templates: nextTemplates,
      },
    });

    await revalidate();
  };

  const onEnabledChange = async (nextEnabled: boolean) => {
    try {
      await persistTemplates(nextEnabled, templates);

      toast({
        title: _(msg`Email Templates Updated`),
        description: _(msg`The email template settings have been updated successfully.`),
        duration: 5000,
      });
    } catch (_err) {
      toast({
        title: _(msg`An unknown error occurred`),
        variant: 'destructive',
        description: _(
          msg`We encountered an unknown error while attempting to update the email templates. Please try again later.`,
        ),
      });
    }
  };

  return (
    <div>
      <SettingsHeader
        title={_(msg`Email Templates`)}
        subtitle={_(msg`Customise the subject and body of the transactional emails sent by this instance`)}
      />

      <div className="mt-8">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-semibold">
              <Trans>Enable Custom Templates</Trans>
            </h2>
            <p className="mt-2 max-w-xl text-muted-foreground text-sm">
              <Trans>
                When enabled, the custom subjects and bodies below are applied to outgoing emails. Templates left blank
                fall back to the default wording.
              </Trans>
            </p>
          </div>

          <Switch checked={enabled} disabled={isUpdateSiteSettingLoading} onCheckedChange={onEnabledChange} />
        </div>

        <Accordion type="multiple" className="mt-6">
          {EMAIL_TEMPLATE_IDS.map((templateId) => (
            <EmailTemplateAccordionItem
              key={templateId}
              templateId={templateId}
              enabled={enabled}
              templates={templates}
              onPersist={persistTemplates}
            />
          ))}
        </Accordion>
      </div>
    </div>
  );
}

const ZEmailTemplateFormSchema = z.object({
  subject: z.string().max(500),
  body: z.string().max(10000),
});

type TEmailTemplateFormSchema = z.infer<typeof ZEmailTemplateFormSchema>;

type EmailTemplateAccordionItemProps = {
  templateId: TEmailTemplateId;
  enabled: boolean;
  templates: TSiteSettingsEmailTemplatesSchema['data']['templates'];
  onPersist: (enabled: boolean, templates: TSiteSettingsEmailTemplatesSchema['data']['templates']) => Promise<void>;
};

const EmailTemplateAccordionItem = ({ templateId, enabled, templates, onPersist }: EmailTemplateAccordionItemProps) => {
  const { _ } = useLingui();
  const { toast } = useToast();

  const meta = EMAIL_TEMPLATE_META[templateId];
  const override = templates[templateId];

  const form = useForm<TEmailTemplateFormSchema>({
    resolver: zodResolver(ZEmailTemplateFormSchema),
    defaultValues: {
      subject: override?.subject ?? '',
      body: override?.body ?? '',
    },
  });

  const isCustomised = Boolean(override && (override.subject.trim() || override.body.trim()));

  const onSubmit = async ({ subject, body }: TEmailTemplateFormSchema) => {
    try {
      const nextTemplates = { ...templates };

      if (subject.trim() || body.trim()) {
        nextTemplates[templateId] = { subject, body };
      } else {
        delete nextTemplates[templateId];
      }

      await onPersist(enabled, nextTemplates);

      form.reset({ subject, body });

      toast({
        title: _(msg`Email Template Updated`),
        description: _(msg`The email template has been updated successfully.`),
        duration: 5000,
      });
    } catch (_err) {
      toast({
        title: _(msg`An unknown error occurred`),
        variant: 'destructive',
        description: _(
          msg`We encountered an unknown error while attempting to update the email template. Please try again later.`,
        ),
      });
    }
  };

  const onReset = async () => {
    form.reset({ subject: '', body: '' });
    await form.handleSubmit(onSubmit)();
  };

  return (
    <AccordionItem value={templateId}>
      <AccordionTrigger>
        <span className="flex items-center gap-x-2">
          {_(meta.title)}

          {isCustomised && (
            <Badge variant="secondary">
              <Trans>Customised</Trans>
            </Badge>
          )}
        </span>
      </AccordionTrigger>

      <AccordionContent>
        <p className="text-muted-foreground text-sm">{_(meta.description)}</p>

        <Form {...form}>
          <form className="mt-4 flex flex-col gap-y-4" onSubmit={form.handleSubmit(onSubmit)}>
            <fieldset className="flex flex-col gap-y-4" disabled={form.formState.isSubmitting}>
              <FormField
                control={form.control}
                name="subject"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      <Trans>Subject</Trans>
                    </FormLabel>

                    <FormControl>
                      <Input placeholder={_(meta.defaultSubject)} {...field} />
                    </FormControl>

                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="body"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      <Trans>Body</Trans>
                    </FormLabel>

                    <FormControl>
                      <Textarea className="h-32 resize-none" placeholder={_(meta.defaultBody)} {...field} />
                    </FormControl>

                    <FormDescription>
                      <Trans>
                        Available variables: {meta.variables.map((variable) => `{${variable}}`).join(', ')}. Leave a
                        field blank to use the default.
                      </Trans>
                    </FormDescription>

                    <FormMessage />
                  </FormItem>
                )}
              />
            </fieldset>

            <div className="flex justify-end gap-x-2">
              {isCustomised && (
                <Button type="button" variant="ghost" disabled={form.formState.isSubmitting} onClick={onReset}>
                  <Trans>Reset to Default</Trans>
                </Button>
              )}

              <Button type="submit" loading={form.formState.isSubmitting}>
                <Trans>Save Template</Trans>
              </Button>
            </div>
          </form>
        </Form>
      </AccordionContent>
    </AccordionItem>
  );
};

type EmailTemplateMeta = {
  title: MessageDescriptor;
  description: MessageDescriptor;
  defaultSubject: MessageDescriptor;
  defaultBody: MessageDescriptor;
  variables: string[];
};

const SIGNING_VARIABLES = ['documentName', 'recipientName', 'recipientEmail', 'senderName', 'senderEmail'];

const EMAIL_TEMPLATE_META: Record<TEmailTemplateId, EmailTemplateMeta> = {
  'signing-request': {
    title: msg`Signing Request`,
    description: msg`Sent to a recipient when they are invited to sign or approve a document.`,
    defaultSubject: msg`Please sign this document`,
    defaultBody: msg`{senderName} has invited you to sign the document "{documentName}".`,
    variables: SIGNING_VARIABLES,
  },
  'document-pending': {
    title: msg`Document Pending`,
    description: msg`Sent to a recipient who has signed when the document is still waiting for other signers.`,
    defaultSubject: msg`Waiting for others to complete signing`,
    defaultBody: msg`"{documentName}" has been signed. We're still waiting for other signers to sign this document.`,
    variables: ['documentName', 'recipientName', 'recipientEmail'],
  },
  'document-completed': {
    title: msg`Document Completed`,
    description: msg`Sent to recipients and the document owner when a document has been completed, including the copy of the signed documents.`,
    defaultSubject: msg`Signing Complete!`,
    defaultBody: msg`The document "{documentName}" has been completed. A copy of the signed document is attached.`,
    variables: SIGNING_VARIABLES,
  },
  'document-cancelled': {
    title: msg`Document Cancelled`,
    description: msg`Sent to recipients when a document they were asked to sign has been cancelled.`,
    defaultSubject: msg`Document "{documentName}" Cancelled`,
    defaultBody: msg`{senderName} has cancelled the document "{documentName}". You don't need to sign it anymore.`,
    variables: SIGNING_VARIABLES,
  },
  'document-rejected': {
    title: msg`Document Rejected`,
    description: msg`Sent when a recipient rejects a document: a confirmation to the recipient and a notification to the document owner.`,
    defaultSubject: msg`Document "{documentName}" - Rejected by {recipientName}`,
    defaultBody: msg`{recipientName} has rejected the document "{documentName}".`,
    variables: SIGNING_VARIABLES,
  },
};
