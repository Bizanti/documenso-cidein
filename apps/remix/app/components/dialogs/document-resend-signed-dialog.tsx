import { getRecipientType } from '@documenso/lib/client-only/recipient-type';
import { AppError } from '@documenso/lib/errors/app-error';
import type { TEnvelopeRecipientLite } from '@documenso/lib/types/recipient';
import { recipientAbbreviation } from '@documenso/lib/utils/recipient-formatter';
import { getRecipientRoleCapabilities } from '@documenso/lib/utils/recipients';
import { trpc as trpcReact } from '@documenso/trpc/react';
import { cn } from '@documenso/ui/lib/utils';
import { Button } from '@documenso/ui/primitives/button';
import { Checkbox } from '@documenso/ui/primitives/checkbox';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@documenso/ui/primitives/dialog';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel } from '@documenso/ui/primitives/form/form';
import { Textarea } from '@documenso/ui/primitives/textarea';
import { useToast } from '@documenso/ui/primitives/use-toast';
import { zodResolver } from '@hookform/resolvers/zod';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import * as z from 'zod';

import { StackAvatar } from '../general/stack-avatar';

export type DocumentResendSignedDialogProps = {
  documentId: number;
  recipients: TEnvelopeRecipientLite[];
  trigger?: React.ReactNode;
};

export const ZDocumentResendSignedFormSchema = z.object({
  recipients: z.array(z.number()).min(1, {
    message: msg`You must select at least one recipient`.id,
  }),
  message: z.string().max(5000).optional(),
});

export type TDocumentResendSignedFormSchema = z.infer<typeof ZDocumentResendSignedFormSchema>;

/**
 * Delivers the signed document to the selected recipients again, with an
 * optional message. Every delivery is recorded on the document audit log and
 * copies in the team members holding the SGC role.
 */
export const DocumentResendSignedDialog = ({ documentId, recipients, trigger }: DocumentResendSignedDialogProps) => {
  const { toast } = useToast();
  const { t, i18n } = useLingui();

  const [isOpen, setIsOpen] = useState(false);

  const trpcUtils = trpcReact.useUtils();

  const { mutateAsync: resendSignedDocument } = trpcReact.document.resendSignedDocument.useMutation();

  const form = useForm<TDocumentResendSignedFormSchema>({
    defaultValues: {
      recipients: [],
      message: '',
    },
    resolver: zodResolver(ZDocumentResendSignedFormSchema),
  });

  const {
    handleSubmit,
    formState: { isSubmitting },
  } = form;

  // Recipients the signed document may be delivered to. Controlled signers never
  // receive the completed document.
  const selectableRecipients = recipients.filter(
    (recipient) => getRecipientRoleCapabilities(recipient.role).receivesCompletedPdf,
  );

  const onFormSubmit = async ({ recipients, message }: TDocumentResendSignedFormSchema) => {
    try {
      await resendSignedDocument({
        documentId,
        recipients,
        message: message?.trim() ? message : undefined,
      });

      await trpcUtils.document.auditLog.find.invalidate();
      await trpcUtils.document.findDocumentsInternal.invalidate();

      toast({
        title: t`Signed document resent`,
        description: t`The signed document has been sent to the selected recipients.`,
        duration: 5000,
      });

      setIsOpen(false);
    } catch (err) {
      const error = AppError.parseError(err);

      toast({
        title: i18n._(msg`Something went wrong`),
        description: i18n._(error.message ?? msg`The signed document could not be sent. Please try again.`),
        variant: 'destructive',
        duration: 7500,
      });
    }
  };

  useEffect(() => {
    if (!isOpen) {
      form.reset();
    }
  }, [isOpen]);

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>

      <DialogContent className="max-w-md" hideClose>
        <DialogHeader>
          <DialogTitle>
            <Trans>Resend Signed Document</Trans>
          </DialogTitle>

          <DialogDescription>
            <Trans>Send the signed document to the following recipients again.</Trans>
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={handleSubmit(onFormSubmit)}>
            <fieldset disabled={isSubmitting} className="flex flex-col gap-4">
              <FormField
                control={form.control}
                name="recipients"
                render={({ field: { value, onChange }, fieldState: { error } }) => (
                  <FormItem>
                    {selectableRecipients.map((recipient) => (
                      <div key={recipient.id} className="flex flex-row items-center justify-between gap-x-3 px-3">
                        <FormLabel
                          className={cn('my-2 flex items-center gap-2 font-normal', {
                            'opacity-50': !value.includes(recipient.id),
                          })}
                        >
                          <StackAvatar
                            type={getRecipientType(recipient)}
                            fallbackText={recipientAbbreviation(recipient)}
                          />
                          {recipient.email}
                        </FormLabel>

                        <FormControl>
                          <Checkbox
                            data-testid={`resend-signed-recipient-${recipient.id}`}
                            className="h-5 w-5 rounded-full"
                            value={recipient.id}
                            checked={value.includes(recipient.id)}
                            onCheckedChange={(checked: boolean) =>
                              checked
                                ? onChange([...value, recipient.id])
                                : onChange(value.filter((id) => id !== recipient.id))
                            }
                          />
                        </FormControl>
                      </div>
                    ))}

                    {error && <p className="px-3 text-destructive text-sm">{error.message}</p>}
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="message"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      <Trans>Message (optional)</Trans>
                    </FormLabel>

                    <FormControl>
                      <Textarea
                        data-testid="resend-signed-message"
                        className="min-h-[80px]"
                        placeholder={t`Add a message for the recipients`}
                        {...field}
                      />
                    </FormControl>

                    <FormDescription>
                      <Trans>This message replaces the default copy in the email.</Trans>
                    </FormDescription>
                  </FormItem>
                )}
              />

              <DialogFooter>
                <DialogClose asChild>
                  <Button type="button" variant="secondary" disabled={isSubmitting}>
                    <Trans>Cancel</Trans>
                  </Button>
                </DialogClose>

                <Button data-testid="resend-signed-submit" loading={isSubmitting} type="submit">
                  <Trans>Send</Trans>
                </Button>
              </DialogFooter>
            </fieldset>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
};
