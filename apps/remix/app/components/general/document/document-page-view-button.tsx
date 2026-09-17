import { useSession } from '@documenso/lib/client-only/providers/session';
import type { TEnvelope } from '@documenso/lib/types/envelope';
import { isDocumentCompleted } from '@documenso/lib/utils/document';
import { getRecipientRoleCapabilities } from '@documenso/lib/utils/recipients';
import { formatDocumentsPath } from '@documenso/lib/utils/teams';
import { Button } from '@documenso/ui/primitives/button';
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { DocumentStatus, RecipientRole, SigningStatus } from '@prisma/client';
import { CheckCircle, Download, EyeIcon, LockIcon, Pencil } from 'lucide-react';
import { Link } from 'react-router';
import { match } from 'ts-pattern';

import { EnvelopeDownloadDialog } from '~/components/dialogs/envelope-download-dialog';
import { useEnvelopeDownloadPolicy } from '~/components/dialogs/envelope-download-policy';

export type DocumentPageViewButtonProps = {
  envelope: TEnvelope;
};

export const DocumentPageViewButton = ({ envelope }: DocumentPageViewButtonProps) => {
  const { user } = useSession();
  const { _ } = useLingui();

  const recipient = envelope.recipients.find((recipient) => recipient.email === user.email);

  const isRecipient = !!recipient;
  const isPending = envelope.status === DocumentStatus.PENDING;
  const isComplete = isDocumentCompleted(envelope);
  const isSigned = recipient?.signingStatus === SigningStatus.SIGNED;
  const role = recipient?.role;
  const canDownload = role ? getRecipientRoleCapabilities(role).canDownload : true;

  const { downloadPolicy } = useEnvelopeDownloadPolicy({
    envelopeId: envelope.id,
    token: recipient?.token,
    enabled: isComplete && canDownload,
  });

  const isDownloadLocked =
    downloadPolicy !== undefined && !downloadPolicy.canDownloadSigned && !downloadPolicy.canDownloadOriginal;

  const documentsPath = formatDocumentsPath(envelope.team.url);
  const formatPath = `${documentsPath}/${envelope.id}/edit`;

  return match({
    isRecipient,
    isPending,
    isComplete,
    isSigned,
    canDownload,
    internalVersion: envelope.internalVersion,
  })
    .with({ isRecipient: true, isPending: true, isSigned: false }, () => (
      <Button className="w-full" asChild>
        <a href={`/sign/${recipient?.token}`}>
          {match(role)
            .with(RecipientRole.SIGNER, RecipientRole.CONTROLLED_SIGNER, () => (
              <>
                <Pencil className="mr-2 -ml-1 h-4 w-4" />
                <Trans>Sign</Trans>
              </>
            ))
            .with(RecipientRole.APPROVER, () => (
              <>
                <CheckCircle className="mr-2 -ml-1 h-4 w-4" />
                <Trans>Approve</Trans>
              </>
            ))
            .otherwise(() => (
              <>
                <EyeIcon className="mr-2 -ml-1 h-4 w-4" />
                <Trans>View</Trans>
              </>
            ))}
        </a>
      </Button>
    ))
    .with({ isComplete: false }, () => (
      <Button className="w-full" asChild>
        <Link to={formatPath}>
          <Trans>Edit</Trans>
        </Link>
      </Button>
    ))
    .with({ isComplete: true, canDownload: false }, () => null)
    .with({ isComplete: true }, () =>
      isDownloadLocked ? (
        <Button className="w-full" disabled title={_(msg`The download window for this document has expired.`)}>
          <LockIcon className="mr-2 -ml-1 inline h-4 w-4" />
          <Trans>Download locked</Trans>
        </Button>
      ) : (
        <EnvelopeDownloadDialog
          envelopeId={envelope.id}
          envelopeStatus={envelope.status}
          envelopeItems={envelope.envelopeItems}
          token={recipient?.token}
          downloadPolicy={downloadPolicy}
          trigger={
            <Button className="w-full">
              <Download className="mr-2 -ml-1 inline h-4 w-4" />
              <Trans>Download</Trans>
            </Button>
          }
        />
      ),
    )
    .otherwise(() => null);
};
