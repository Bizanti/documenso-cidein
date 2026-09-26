import { useSession } from '@documenso/lib/client-only/providers/session';
import type { TDocumentMany as TDocumentRow } from '@documenso/lib/types/document';
import { isDocumentCompleted } from '@documenso/lib/utils/document';
import { getEnvelopeItemPermissions } from '@documenso/lib/utils/envelope';
import {
  findRecipientByEmail,
  getRecipientRoleCapabilities,
  isSigningRecipientRole,
} from '@documenso/lib/utils/recipients';
import { formatDocumentsPath, hasSgcDownloadPrivileges, isMemberManagerOrAbove } from '@documenso/lib/utils/teams';
import { trpc as trpcReact } from '@documenso/trpc/react';
import { DocumentShareButton } from '@documenso/ui/components/document/document-share-button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@documenso/ui/primitives/dropdown-menu';
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { DocumentStatus, EnvelopeType, RecipientRole } from '@prisma/client';
import {
  CheckCircle,
  Copy,
  Download,
  Edit,
  EyeIcon,
  FileOutputIcon,
  FolderInput,
  History,
  Loader,
  LockIcon,
  MoreHorizontal,
  Pencil,
  Share,
  Trash2,
  XCircle,
} from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';

import { EnvelopeCancelDialog } from '~/components/dialogs/envelope-cancel-dialog';
import { EnvelopeDeleteDialog } from '~/components/dialogs/envelope-delete-dialog';
import { EnvelopeDuplicateDialog } from '~/components/dialogs/envelope-duplicate-dialog';
import { EnvelopeRedistributeDialog } from '~/components/dialogs/envelope-redistribute-dialog';
import { EnvelopeSaveAsTemplateDialog } from '~/components/dialogs/envelope-save-as-template-dialog';
import { DocumentRecipientLinkCopyDialog } from '~/components/general/document/document-recipient-link-copy-dialog';
import { useCurrentTeam } from '~/providers/team';

import { DocumentResendSignedDialog } from '../dialogs/document-resend-signed-dialog';
import { EnvelopeDownloadDialog } from '../dialogs/envelope-download-dialog';
import {
  isAccountDownloadBlocked,
  isRestrictedAccountViewer,
  useEnvelopeDownloadPolicy,
} from '../dialogs/envelope-download-policy';
import { EnvelopeRenameDialog } from '../dialogs/envelope-rename-dialog';

export type DocumentsTableActionDropdownProps = {
  row: TDocumentRow;
  onMoveDocument?: () => void;
};

export const DocumentsTableActionDropdown = ({ row, onMoveDocument }: DocumentsTableActionDropdownProps) => {
  const { user } = useSession();
  const team = useCurrentTeam();

  const { _ } = useLingui();
  const trpcUtils = trpcReact.useUtils();

  const [isRenameDialogOpen, setRenameDialogOpen] = useState(false);
  const [isSaveAsTemplateDialogOpen, setSaveAsTemplateDialogOpen] = useState(false);

  const recipient = findRecipientByEmail({
    recipients: row.recipients,
    userEmail: user.email,
    teamEmail: team.teamEmail?.email,
  });

  const isOwner = row.user.id === user.id;
  // const isRecipient = !!recipient;
  const isDraft = row.status === DocumentStatus.DRAFT;
  const isPending = row.status === DocumentStatus.PENDING;
  const isComplete = isDocumentCompleted(row.status);
  // const isSigned = recipient?.signingStatus === SigningStatus.SIGNED;
  const isCurrentTeamDocument = team && row.team?.url === team.url;
  const canManageDocument = Boolean(isOwner || isCurrentTeamDocument);

  // Recipients without download capabilities (e.g. controlled signers)
  // must not be offered actions that the backend will reject. Team members
  // acting on their own documents keep full access via their session.
  const recipientCapabilities = recipient ? getRecipientRoleCapabilities(recipient.role) : null;
  const canDownloadDocument = canManageDocument || !recipientCapabilities || recipientCapabilities.canDownload;

  // Sharing a signing card is an owner/team action, so viewers acting as a
  // recipient of this document only get it when they can manage the document.
  const canShareDocument = canManageDocument || !recipientCapabilities;

  // Cancelling a document is restricted server-side to the document owner or a
  // privileged team member (ADMIN/MANAGER). Mirror that here so plain MEMBERs
  // don't see a Cancel action that would fail on the server.
  const isPrivilegedTeamMember = isMemberManagerOrAbove(team.currentTeamRole);
  const canCancelDocument = isOwner || isPrivilegedTeamMember;

  // The download window, and the delivery of the signed document, are governed
  // by the owner and the SGC download privileges (ADMIN/SGC).
  const canManageSignedDocument = isOwner || hasSgcDownloadPrivileges(team.currentTeamRole);

  const { downloadPolicy } = useEnvelopeDownloadPolicy({
    envelopeId: row.envelopeId,
    token: canManageDocument ? undefined : recipient?.token,
    enabled: isComplete && canDownloadDocument,
  });

  // A restricted account is not offered a download control: the server refuses
  // every download route for it, so the action would only ever fail.
  const isDownloadBlockedForAccount = isAccountDownloadBlocked(downloadPolicy) || isRestrictedAccountViewer(user);

  const isDownloadLocked =
    !isDownloadBlockedForAccount &&
    downloadPolicy !== undefined &&
    !downloadPolicy.canDownloadSigned &&
    !downloadPolicy.canDownloadOriginal;

  const { canTitleBeChanged } = getEnvelopeItemPermissions(
    {
      completedAt: row.completedAt,
      deletedAt: row.deletedAt,
      type: EnvelopeType.DOCUMENT,
      status: row.status,
    },
    [],
  );

  const documentsPath = formatDocumentsPath(team.url);
  const formatPath = `${documentsPath}/${row.envelopeId}/edit`;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger data-testid="document-table-action-btn">
        <MoreHorizontal className="h-5 w-5 text-muted-foreground" />
      </DropdownMenuTrigger>

      <DropdownMenuContent className="w-52" align="start" forceMount>
        <DropdownMenuLabel>
          <Trans>Action</Trans>
        </DropdownMenuLabel>

        {!isDraft &&
          recipient &&
          recipient?.role !== RecipientRole.CC &&
          recipient?.role !== RecipientRole.ASSISTANT && (
            <DropdownMenuItem disabled={!recipient || isComplete} asChild>
              <a href={`/sign/${recipient?.token}`}>
                {recipient?.role === RecipientRole.VIEWER && (
                  <>
                    <EyeIcon className="mr-2 h-4 w-4" />
                    <Trans>View</Trans>
                  </>
                )}

                {recipient && isSigningRecipientRole(recipient.role) && (
                  <>
                    <Pencil className="mr-2 h-4 w-4" />
                    <Trans>Sign</Trans>
                  </>
                )}

                {recipient?.role === RecipientRole.APPROVER && (
                  <>
                    <CheckCircle className="mr-2 h-4 w-4" />
                    <Trans>Approve</Trans>
                  </>
                )}
              </a>
            </DropdownMenuItem>
          )}

        <DropdownMenuItem disabled={!canManageDocument || isComplete} asChild>
          <Link to={formatPath}>
            <Edit className="mr-2 h-4 w-4" />
            <Trans>Edit</Trans>
          </Link>
        </DropdownMenuItem>

        {canManageDocument && canTitleBeChanged && (
          <DropdownMenuItem onClick={() => setRenameDialogOpen(true)}>
            <Pencil className="mr-2 h-4 w-4" />
            <Trans>Rename</Trans>
          </DropdownMenuItem>
        )}

        {canDownloadDocument &&
          !isDownloadBlockedForAccount &&
          (isDownloadLocked ? (
            <DropdownMenuItem disabled onSelect={(e) => e.preventDefault()}>
              <div className="flex flex-col">
                <div className="flex items-center">
                  <LockIcon className="mr-2 h-4 w-4" />
                  <Trans>Download</Trans>
                </div>
                <span className="pl-6 text-muted-foreground text-xs">
                  <Trans>The download window has expired</Trans>
                </span>
              </div>
            </DropdownMenuItem>
          ) : (
            <EnvelopeDownloadDialog
              envelopeId={row.envelopeId}
              envelopeStatus={row.status}
              isLegacy={row.internalVersion === 1}
              token={canManageDocument ? undefined : recipient?.token}
              downloadPolicy={downloadPolicy}
              trigger={
                <DropdownMenuItem asChild onSelect={(e) => e.preventDefault()}>
                  <div>
                    <Download className="mr-2 h-4 w-4" />
                    <Trans>Download</Trans>
                  </div>
                </DropdownMenuItem>
              }
            />
          ))}

        {row.status === DocumentStatus.COMPLETED && canManageSignedDocument && (
          <DocumentResendSignedDialog
            documentId={row.id}
            recipients={row.recipients}
            trigger={
              <DropdownMenuItem asChild onSelect={(e) => e.preventDefault()}>
                <div data-testid="document-resend-signed-action">
                  <History className="mr-2 h-4 w-4" />
                  <Trans>Resend Signed Document</Trans>
                </div>
              </DropdownMenuItem>
            }
          />
        )}

        <EnvelopeDuplicateDialog
          envelopeId={row.envelopeId}
          envelopeType={EnvelopeType.DOCUMENT}
          trigger={
            <DropdownMenuItem asChild onSelect={(e) => e.preventDefault()}>
              <div>
                <Copy className="mr-2 h-4 w-4" />
                <Trans>Duplicate</Trans>
              </div>
            </DropdownMenuItem>
          }
        />

        <DropdownMenuItem onClick={() => setSaveAsTemplateDialogOpen(true)}>
          <FileOutputIcon className="mr-2 h-4 w-4" />
          <Trans>Save as Template</Trans>
        </DropdownMenuItem>

        {onMoveDocument && canManageDocument && (
          <DropdownMenuItem onClick={onMoveDocument} onSelect={(e) => e.preventDefault()}>
            <FolderInput className="mr-2 h-4 w-4" />
            <Trans>Move to Folder</Trans>
          </DropdownMenuItem>
        )}

        {canCancelDocument && isPending && (
          <EnvelopeCancelDialog
            id={row.envelopeId}
            title={row.title}
            onCancel={async () => {
              await trpcUtils.document.findDocumentsInternal.invalidate();
            }}
            trigger={
              <DropdownMenuItem asChild onSelect={(e) => e.preventDefault()}>
                <div>
                  <XCircle className="mr-2 h-4 w-4" />
                  <Trans>Cancel</Trans>
                </div>
              </DropdownMenuItem>
            }
          />
        )}

        <EnvelopeDeleteDialog
          id={row.envelopeId}
          type={EnvelopeType.DOCUMENT}
          status={row.status}
          title={row.title}
          canManageDocument={canManageDocument}
          trigger={
            <DropdownMenuItem asChild onSelect={(e) => e.preventDefault()}>
              <div>
                <Trash2 className="mr-2 h-4 w-4" />
                {canManageDocument ? _(msg`Delete`) : _(msg`Hide`)}
              </div>
            </DropdownMenuItem>
          }
        />

        <DropdownMenuLabel>
          <Trans>Share</Trans>
        </DropdownMenuLabel>

        {canManageDocument && (
          <DocumentRecipientLinkCopyDialog
            recipients={row.recipients}
            trigger={
              <DropdownMenuItem disabled={!isPending} asChild onSelect={(e) => e.preventDefault()}>
                <div>
                  <Copy className="mr-2 h-4 w-4" />
                  <Trans>Signing Links</Trans>
                </div>
              </DropdownMenuItem>
            }
          />
        )}

        {canManageDocument && (
          <EnvelopeRedistributeDialog
            envelope={{
              id: row.envelopeId,
              status: row.status,
              type: EnvelopeType.DOCUMENT,
              recipients: row.recipients,
            }}
            envelopeType={EnvelopeType.DOCUMENT}
            trigger={
              <DropdownMenuItem asChild onSelect={(e) => e.preventDefault()}>
                <div>
                  <History className="mr-2 h-4 w-4" />
                  <Trans>Resend</Trans>
                </div>
              </DropdownMenuItem>
            }
          />
        )}

        {canShareDocument && (
          <DocumentShareButton
            documentId={row.id}
            trigger={({ loading, disabled }) => (
              <DropdownMenuItem disabled={disabled || isDraft} onSelect={(e) => e.preventDefault()}>
                <div className="flex items-center">
                  {loading ? <Loader className="mr-2 h-4 w-4" /> : <Share className="mr-2 h-4 w-4" />}
                  <Trans>Share Signing Card</Trans>
                </div>
              </DropdownMenuItem>
            )}
          />
        )}
      </DropdownMenuContent>

      <EnvelopeSaveAsTemplateDialog
        envelopeId={row.envelopeId}
        open={isSaveAsTemplateDialogOpen}
        onOpenChange={setSaveAsTemplateDialogOpen}
      />

      <EnvelopeRenameDialog
        id={row.envelopeId}
        initialTitle={row.title}
        open={isRenameDialogOpen}
        onOpenChange={setRenameDialogOpen}
        onSuccess={async () => {
          await trpcUtils.document.findDocumentsInternal.invalidate();
        }}
      />
    </DropdownMenu>
  );
};
