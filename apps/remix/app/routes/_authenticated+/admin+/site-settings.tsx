import { getSiteSettings } from '@documenso/lib/server-only/site-settings/get-site-settings';
import { SITE_SETTINGS_BANNER_ID } from '@documenso/lib/server-only/site-settings/schemas/banner';
import {
  SITE_SETTINGS_DOWNLOAD_WINDOW_ID,
  type TSiteSettingsDownloadWindowSchema,
} from '@documenso/lib/server-only/site-settings/schemas/download-window';
import { SITE_SETTINGS_EMAIL_BLOCKLIST_ID } from '@documenso/lib/server-only/site-settings/schemas/email-blocklist';
import { trpc as trpcReact } from '@documenso/trpc/react';
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
import { useToast } from '@documenso/ui/primitives/use-toast';
import { zodResolver } from '@hookform/resolvers/zod';
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { useForm } from 'react-hook-form';
import { useRevalidator } from 'react-router';
import { z } from 'zod';

import { AdminEmailBlocklistSection } from '~/components/general/admin-email-blocklist-section';
import { AdminSiteBannerSection } from '~/components/general/admin-site-banner-section';
import { SettingsHeader } from '~/components/general/settings-header';
import type { Route } from './+types/site-settings';

export async function loader() {
  const settings = await getSiteSettings();

  const banner = settings.find((setting) => setting.id === SITE_SETTINGS_BANNER_ID);
  const emailBlocklist = settings.find((setting) => setting.id === SITE_SETTINGS_EMAIL_BLOCKLIST_ID);
  const downloadWindow = settings.find((setting) => setting.id === SITE_SETTINGS_DOWNLOAD_WINDOW_ID);

  return { banner, emailBlocklist, downloadWindow };
}

export default function AdminSiteSettingsPage({ loaderData }: Route.ComponentProps) {
  const { banner, emailBlocklist, downloadWindow } = loaderData;

  const { _ } = useLingui();

  return (
    <div>
      <SettingsHeader title={_(msg`Site Settings`)} subtitle={_(msg`Manage your site settings here`)} />

      <div className="mt-8 space-y-12">
        <AdminSiteBannerSection banner={banner} />

        <AdminEmailBlocklistSection emailBlocklist={emailBlocklist} />

        <AdminDownloadWindowSection downloadWindow={downloadWindow} />
      </div>
    </div>
  );
}

const ZDownloadWindowFormSchema = z.object({
  enabled: z.boolean(),
  hours: z.number().int().min(1).max(8760),
});

type TDownloadWindowFormSchema = z.infer<typeof ZDownloadWindowFormSchema>;

type AdminDownloadWindowSectionProps = {
  downloadWindow: TSiteSettingsDownloadWindowSchema | undefined;
};

const AdminDownloadWindowSection = ({ downloadWindow }: AdminDownloadWindowSectionProps) => {
  const { toast } = useToast();
  const { _ } = useLingui();
  const { revalidate } = useRevalidator();

  const form = useForm<TDownloadWindowFormSchema>({
    resolver: zodResolver(ZDownloadWindowFormSchema),
    defaultValues: {
      enabled: downloadWindow?.enabled ?? false,
      hours: downloadWindow?.data?.hours ?? 48,
    },
  });

  const enabled = form.watch('enabled');

  const { mutateAsync: updateSiteSetting, isPending: isUpdateSiteSettingLoading } =
    trpcReact.admin.updateSiteSetting.useMutation();

  const onDownloadWindowUpdate = async ({ enabled, hours }: TDownloadWindowFormSchema) => {
    try {
      await updateSiteSetting({
        id: SITE_SETTINGS_DOWNLOAD_WINDOW_ID,
        enabled,
        data: {
          hours,
        },
      });

      toast({
        title: _(msg`Download Window Updated`),
        description: _(msg`The download window has been updated successfully.`),
        duration: 5000,
      });

      await revalidate();
    } catch (_err) {
      toast({
        title: _(msg`An unknown error occurred`),
        variant: 'destructive',
        description: _(
          msg`We encountered an unknown error while attempting to update the download window. Please try again later.`,
        ),
      });
    }
  };

  return (
    <div>
      <h2 className="font-semibold">
        <Trans>Download Window</Trans>
      </h2>
      <p className="mt-2 text-muted-foreground text-sm">
        <Trans>
          Limit how long completed documents can be downloaded. Once the window expires, recipients will no longer be
          able to download the document. This global value applies unless a document or template defines its own.
        </Trans>
      </p>

      <Form {...form}>
        <form className="mt-4 flex flex-col rounded-md" onSubmit={form.handleSubmit(onDownloadWindowUpdate)}>
          <FormField
            control={form.control}
            name="enabled"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  <Trans>Enabled</Trans>
                </FormLabel>

                <FormControl>
                  <div>
                    <Switch checked={field.value} onCheckedChange={field.onChange} />
                  </div>
                </FormControl>
              </FormItem>
            )}
          />

          <fieldset className="mt-4" disabled={!enabled} aria-disabled={!enabled}>
            <FormField
              control={form.control}
              name="hours"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    <Trans>Window (hours)</Trans>
                  </FormLabel>

                  <FormControl>
                    <Input
                      type="number"
                      min={1}
                      max={8760}
                      className="max-w-40"
                      {...field}
                      onChange={(event) => field.onChange(event.target.valueAsNumber)}
                      value={Number.isNaN(field.value) ? '' : field.value}
                    />
                  </FormControl>

                  <FormDescription>
                    <Trans>Number of hours download links remain valid after completion (1–8760).</Trans>
                  </FormDescription>

                  <FormMessage />
                </FormItem>
              )}
            />
          </fieldset>

          <Button type="submit" loading={isUpdateSiteSettingLoading} className="mt-4 justify-end self-end">
            <Trans>Update Download Window</Trans>
          </Button>
        </form>
      </Form>
    </div>
  );
};
