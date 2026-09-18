import {
  createZipWriter,
  sanitizeZipPathSegment,
  type ZipFileEntry,
} from '@documenso/lib/client-only/create-zip-writer';
import { downloadFile } from '@documenso/lib/client-only/download-file';
import { fetchPDF } from '@documenso/lib/client-only/download-pdf';
import { trpc } from '@documenso/trpc/react';
import { Alert, AlertDescription } from '@documenso/ui/primitives/alert';
import { Button } from '@documenso/ui/primitives/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@documenso/ui/primitives/dialog';
import { RadioGroupSegmented, RadioGroupSegmentedItem } from '@documenso/ui/primitives/radio-group';
import { useToast } from '@documenso/ui/primitives/use-toast';
import { plural } from '@lingui/core/macro';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { DocumentStatus } from '@prisma/client';
import type * as DialogPrimitive from '@radix-ui/react-dialog';
import { LockIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { match } from 'ts-pattern';

/**
 * The maximum number of documents that can be downloaded in a single bulk
 * download. Each document requires fetching its full PDFs into the browser,
 * so this bounds both request volume and blob storage usage. Matches the
 * spirit of the server-side 100 cap on bulk move/delete/cancel.
 */
export const MAX_BULK_DOWNLOAD_ENVELOPES = 50;

type BulkDownloadVersion = 'signed' | 'original' | 'pending';

export type EnvelopeBulkDownloadItem = {
  id: string;
  title: string;
  status: DocumentStatus;

  /**
   * Whether the envelope is a legacy (v1) envelope. Legacy envelopes use a
   * different field-rendering pipeline that the partial PDF helper does not
   * implement, so the Partial option is hidden for them.
   */
  isLegacy: boolean;
};

const getDefaultVersion = (envelope: EnvelopeBulkDownloadItem): BulkDownloadVersion =>
  envelope.status === DocumentStatus.COMPLETED ? 'signed' : 'original';

export type EnvelopesBulkDownloadDialogProps = {
  envelopes: EnvelopeBulkDownloadItem[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: (successfulEnvelopeIds: string[]) => void;
} & Omit<DialogPrimitive.DialogProps, 'children'>;

export const EnvelopesBulkDownloadDialog = ({
  envelopes,
  open,
  onOpenChange,
  onSuccess,
  ...props
}: EnvelopesBulkDownloadDialogProps) => {
  const { t } = useLingui();
  const { toast } = useToast();

  const [versionMap, setVersionMap] = useState<Record<string, BulkDownloadVersion>>({});
  const [progress, setProgress] = useState(0);
  const [isDownloading, setIsDownloading] = useState(false);

  const abortRef = useRef(false);

  const trpcUtils = trpc.useUtils();

  const isOverDownloadLimit = envelopes.length > MAX_BULK_DOWNLOAD_ENVELOPES;

  /**
   * The download policy of every selected document, resolved in a single request
   * so the dialog can tell the viewer which ones the download window blocks
   * instead of failing halfway through the zip with a generic error.
   */
  const { data: downloadPoliciesPayload, isLoading: isLoadingDownloadPolicies } =
    trpc.document.getEnvelopeDownloadPolicies.useQuery(
      {
        envelopeIds: envelopes.slice(0, MAX_BULK_DOWNLOAD_ENVELOPES).map((envelope) => envelope.id),
      },
      {
        enabled: open && envelopes.length > 0 && !isOverDownloadLimit,
      },
    );

  const downloadPoliciesById = useMemo(
    () => new Map((downloadPoliciesPayload?.data ?? []).map((policy) => [policy.envelopeId, policy])),
    [downloadPoliciesPayload],
  );

  /**
   * Whether every downloadable version of a document is out of reach for the
   * current viewer, which is what the download window expiring does to the
   * signed and the original version of a completed document.
   *
   * Documents the batch has not resolved yet are treated as downloadable so the
   * dialog keeps its previous behaviour when the policy is unavailable.
   */
  const isEnvelopeDownloadLocked = (envelope: EnvelopeBulkDownloadItem): boolean => {
    const policy = downloadPoliciesById.get(envelope.id);

    if (!policy) {
      return false;
    }

    return !policy.canDownloadSigned && !policy.canDownloadOriginal;
  };

  const lockedEnvelopes = envelopes.filter((envelope) => isEnvelopeDownloadLocked(envelope));
  const downloadableEnvelopes = envelopes.filter((envelope) => !isEnvelopeDownloadLocked(envelope));

  useEffect(() => {
    if (!open) {
      return;
    }

    setVersionMap(Object.fromEntries(envelopes.map((envelope) => [envelope.id, getDefaultVersion(envelope)])));
    setProgress(0);
  }, [open]);

  /**
   * The version to download for an envelope: the one the viewer selected, or the
   * first version the policy still allows when that selection is no longer valid.
   */
  const getDownloadVersion = (envelope: EnvelopeBulkDownloadItem): BulkDownloadVersion => {
    const selectedVersion = versionMap[envelope.id];
    const versionOptions = getVersionOptions(envelope);

    if (selectedVersion && (!versionOptions || versionOptions.some((option) => option.value === selectedVersion))) {
      return selectedVersion;
    }

    return versionOptions?.[0]?.value ?? getDefaultVersion(envelope);
  };

  /**
   * The version options selectable for an envelope, mirroring the gating used
   * by the single envelope download dialog:
   *   - COMPLETED: signed or original.
   *   - PENDING (non-legacy): partial or original. Legacy envelopes use a
   *     field-rendering pipeline the partial PDF helper does not implement.
   *   - Anything else: original only, so no choice is shown.
   *
   * The download policy of the envelope filters the list further, since a
   * version the server would reject must not be offered: on a completed document
   * the original is limited to ADMIN/SGC even while the window is open.
   */
  const getVersionOptions = (
    envelope: EnvelopeBulkDownloadItem,
  ): { value: BulkDownloadVersion; label: string }[] | null => {
    let versionOptions: { value: BulkDownloadVersion; label: string }[];

    if (envelope.status === DocumentStatus.COMPLETED) {
      versionOptions = [
        { value: 'signed', label: t({ message: 'Signed', context: 'Signed document (adjective)' }) },
        { value: 'original', label: t({ message: 'Original', context: 'Original document (adjective)' }) },
      ];
    } else if (envelope.status === DocumentStatus.PENDING && !envelope.isLegacy) {
      versionOptions = [
        { value: 'pending', label: t({ message: 'Partial', context: 'Partially signed document (adjective)' }) },
        { value: 'original', label: t({ message: 'Original', context: 'Original document (adjective)' }) },
      ];
    } else {
      return null;
    }

    const downloadPolicy = downloadPoliciesById.get(envelope.id);

    // Until the batch resolves the policy, keep every version selectable so the
    // dialog behaves as it did before the policy was known.
    if (!downloadPolicy) {
      return versionOptions;
    }

    const availableVersionOptions = versionOptions.filter((option) =>
      option.value === 'original' ? downloadPolicy.canDownloadOriginal : downloadPolicy.canDownloadSigned,
    );

    return availableVersionOptions.length > 0 ? availableVersionOptions : null;
  };

  const getStatusLabel = (status: DocumentStatus) =>
    match(status)
      .with(DocumentStatus.COMPLETED, () => t`Completed`)
      .with(DocumentStatus.PENDING, () => t`Pending`)
      .with(DocumentStatus.DRAFT, () => t`Draft`)
      .with(DocumentStatus.REJECTED, () => t`Rejected`)
      .with(DocumentStatus.CANCELLED, () => t`Cancelled`)
      .exhaustive();

  const onDownload = async () => {
    if (downloadableEnvelopes.length === 0 || isOverDownloadLimit || isDownloading) {
      return;
    }

    abortRef.current = false;
    setIsDownloading(true);
    setProgress(0);

    const zipWriter = createZipWriter();

    const successfulEnvelopeIds: string[] = [];
    let failedDownloads = 0;

    try {
      for (const envelope of downloadableEnvelopes) {
        if (abortRef.current) {
          break;
        }

        try {
          const downloadVersion = getDownloadVersion(envelope);

          const { data: envelopeItems } = await trpcUtils.envelope.item.getManyByToken.fetch({
            envelopeId: envelope.id,
            access: {
              type: 'user',
            },
          });

          // Each envelope's items are grouped in their own folder. The id
          // prefix guarantees uniqueness, the truncated title keeps it
          // readable without risking overly long extraction paths.
          const folderName = sanitizeZipPathSegment(`${envelope.id}_${envelope.title}`.slice(0, 96));

          // Buffer this envelope's files before writing so a failed envelope
          // is either fully in the zip or not at all. Files from previous
          // envelopes have already been written to the zip stream and freed.
          const envelopeFiles: ZipFileEntry[] = [];

          for (const envelopeItem of envelopeItems) {
            const { filename, blob } = await fetchPDF({
              envelopeItem,
              token: undefined,
              fileName: envelopeItem.title,
              version: downloadVersion,
            });

            envelopeFiles.push({
              filename: `${folderName}/${sanitizeZipPathSegment(filename)}`,
              data: blob,
            });
          }

          for (const file of envelopeFiles) {
            await zipWriter.addFile(file);
          }

          successfulEnvelopeIds.push(envelope.id);
        } catch (error) {
          console.error(error);
          failedDownloads++;
        }

        setProgress((p) => p + 1);
      }

      // The user intentionally stopped the download, discard anything fetched
      // so far without toasting an error.
      if (abortRef.current) {
        zipWriter.abort();
        return;
      }

      if (successfulEnvelopeIds.length === 0) {
        zipWriter.abort();

        toast({
          title: t`Error`,
          description: t`An error occurred while downloading the documents.`,
          variant: 'destructive',
        });
        return;
      }

      try {
        downloadFile({
          filename: `documenso-documents-${new Date().toISOString().slice(0, 10)}.zip`,
          data: zipWriter.finalize(),
        });
      } catch (error) {
        console.error(error);

        zipWriter.abort();

        toast({
          title: t`Error`,
          description: t`An error occurred while downloading the documents.`,
          variant: 'destructive',
        });

        return;
      }

      // Documents blocked by the download window are left out of the zip instead
      // of failing, so they are reported separately from failures.
      const skippedDownloads = envelopes.length - downloadableEnvelopes.length;

      if (failedDownloads > 0 || skippedDownloads > 0) {
        const descriptionParts = [
          plural(successfulEnvelopeIds.length, {
            one: '# document downloaded.',
            other: '# documents downloaded.',
          }),
        ];

        if (failedDownloads > 0) {
          descriptionParts.push(
            plural(failedDownloads, {
              one: '# document could not be downloaded.',
              other: '# documents could not be downloaded.',
            }),
          );
        }

        if (skippedDownloads > 0) {
          descriptionParts.push(
            plural(skippedDownloads, {
              one: '# document was skipped because its download window has expired.',
              other: '# documents were skipped because their download window has expired.',
            }),
          );
        }

        toast({
          title: t`Documents partially downloaded`,
          description: descriptionParts.join(' '),
          variant: 'destructive',
        });
        onSuccess?.(successfulEnvelopeIds);
        return;
      }

      toast({
        title: t`Documents downloaded`,
        description: plural(successfulEnvelopeIds.length, {
          one: '# document has been downloaded.',
          other: '# documents have been downloaded.',
        }),
      });

      onSuccess?.(successfulEnvelopeIds);
      onOpenChange(false);
    } finally {
      setIsDownloading(false);
    }
  };

  return (
    <Dialog
      {...props}
      open={open}
      onOpenChange={(value) => {
        if (!isDownloading) {
          onOpenChange(value);
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            <Trans>Download Documents</Trans>
          </DialogTitle>

          <DialogDescription>
            <Plural
              value={envelopes.length}
              one="Select the version to download for the selected document."
              other="Select the version to download for each of the # selected documents."
            />
          </DialogDescription>
        </DialogHeader>

        {isOverDownloadLimit && (
          <Alert variant="warning">
            <AlertDescription>
              <Plural
                value={MAX_BULK_DOWNLOAD_ENVELOPES}
                one="You can download up to # document at a time. Deselect some documents to continue."
                other="You can download up to # documents at a time. Deselect some documents to continue."
              />
            </AlertDescription>
          </Alert>
        )}

        {lockedEnvelopes.length > 0 && (
          <Alert variant="warning" data-testid="bulk-download-locked-alert">
            <AlertDescription>
              <Plural
                value={lockedEnvelopes.length}
                one="The download window of # document has expired, so it will be left out of the download. Only team administrators and the SGC role can download it."
                other="The download window of # documents has expired, so they will be left out of the download. Only team administrators and the SGC role can download them."
              />
            </AlertDescription>
          </Alert>
        )}

        <fieldset disabled={isDownloading} className="space-y-4">
          <div className="-mx-3 max-h-96 overflow-y-auto px-3">
            <div className="divide-y divide-border rounded-lg border border-border">
              {envelopes.map((envelope) => {
                const versionOptions = getVersionOptions(envelope);

                // Documents the download window has closed are shown as blocked
                // instead of offering a version the download would reject.
                const isDownloadLocked = isEnvelopeDownloadLocked(envelope);

                return (
                  <div key={envelope.id} className="flex items-center gap-3 px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-foreground text-sm" title={envelope.title}>
                        {envelope.title}
                      </p>
                      <p className="text-muted-foreground text-xs">{getStatusLabel(envelope.status)}</p>
                    </div>

                    {isDownloadLocked ? (
                      <div
                        className="flex shrink-0 items-center gap-2 text-muted-foreground text-xs"
                        data-testid="bulk-download-locked-document"
                        title={t`The download window for this document has expired. Only team administrators and the SGC role can download it.`}
                      >
                        <LockIcon className="h-4 w-4" />
                        <Trans>The download window has expired</Trans>
                      </div>
                    ) : (
                      versionOptions && (
                        <RadioGroupSegmented
                          className="shrink-0"
                          value={getDownloadVersion(envelope)}
                          onValueChange={(value) =>
                            setVersionMap((prev) => ({
                              ...prev,
                              [envelope.id]: value as BulkDownloadVersion,
                            }))
                          }
                          aria-label={t`Download version for ${envelope.title}`}
                        >
                          {versionOptions.map((option) => (
                            <RadioGroupSegmentedItem key={option.value} value={option.value}>
                              {option.label}
                            </RadioGroupSegmentedItem>
                          ))}
                        </RadioGroupSegmented>
                      )
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {isDownloading && (
            <p className="text-muted-foreground text-sm">
              <Trans>
                Downloading {progress} / {downloadableEnvelopes.length}...
              </Trans>
            </p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                if (isDownloading) {
                  abortRef.current = true;
                } else {
                  onOpenChange(false);
                }
              }}
            >
              {isDownloading ? <Trans>Stop</Trans> : <Trans>Cancel</Trans>}
            </Button>

            <Button
              type="button"
              onClick={() => void onDownload()}
              loading={isDownloading || isLoadingDownloadPolicies}
              disabled={downloadableEnvelopes.length === 0 || isOverDownloadLimit || isLoadingDownloadPolicies}
            >
              <Trans>Download</Trans>
            </Button>
          </DialogFooter>
        </fieldset>
      </DialogContent>
    </Dialog>
  );
};
