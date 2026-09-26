import { useOptionalSession } from '@documenso/lib/client-only/providers/session';
import { mapSecondaryIdToDocumentId } from '@documenso/lib/utils/envelope';
import { getRecipientRoleCapabilities } from '@documenso/lib/utils/recipients';
import { Badge } from '@documenso/ui/primitives/badge';
import { Button } from '@documenso/ui/primitives/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@documenso/ui/primitives/dropdown-menu';
import { Separator } from '@documenso/ui/primitives/separator';
import { Plural, Trans } from '@lingui/react/macro';
import { EnvelopeType, RecipientRole } from '@prisma/client';
import { BanIcon, DownloadCloudIcon } from 'lucide-react';
import { Link } from 'react-router';
import { match } from 'ts-pattern';

import { EnvelopeDownloadDialog } from '~/components/dialogs/envelope-download-dialog';
import { isRestrictedAccountViewer } from '~/components/dialogs/envelope-download-policy';
import { useEmbedSigningContext } from '~/components/embed/embed-signing-context';
import { BrandingLogo } from '~/components/general/branding-logo';

import { BrandingLogoIcon } from '../branding-logo-icon';
import { DocumentSigningRejectDialog } from '../document-signing/document-signing-reject-dialog';
import { useRequiredEnvelopeSigningContext } from '../document-signing/envelope-signing-provider';
import { EnvelopeSignerCompleteDialog } from './envelope-signing-complete-dialog';

export const EnvelopeSignerHeader = () => {
  const { envelopeData, envelope, recipientFieldsRemaining, recipient } = useRequiredEnvelopeSigningContext();

  const isEmbedSigning = useEmbedSigningContext() !== null;

  // The URL points at the branding this envelope was pinned to when it was
  // created, not at whatever the team has configured right now.
  const brandingLogoUrl = isEmbedSigning ? null : envelopeData.settings.brandingLogoUrl;

  return (
    <nav className="embed--DocumentWidgetHeader flex max-w-screen flex-row justify-between border-border border-b bg-background px-4 py-3 md:px-6">
      {/* Left side - Logo and title */}
      <div className="flex min-w-0 flex-1 items-center space-x-2 md:w-auto md:flex-none">
        {!isEmbedSigning &&
          (brandingLogoUrl ? (
            <img
              src={brandingLogoUrl}
              alt={`${envelope.team.name}'s Logo`}
              className="h-6 w-auto flex-shrink-0"
            />
          ) : (
            <Link to="/" className="flex-shrink-0">
              <BrandingLogo className="hidden h-6 w-auto md:block" />
              <BrandingLogoIcon className="h-6 w-auto md:hidden" />
            </Link>
          ))}

        <h1 title={envelope.title} className="min-w-0 truncate font-semibold text-base text-foreground md:hidden">
          {envelope.title}
        </h1>

        {!isEmbedSigning && <Separator orientation="vertical" className="hidden h-6 md:block" />}

        <div className="hidden items-center space-x-2 md:flex">
          <h1 className="whitespace-nowrap font-medium text-foreground text-sm">{envelope.title}</h1>

          <Badge>
            {match(recipient.role)
              .with(RecipientRole.VIEWER, () => <Trans>Viewer</Trans>)
              .with(RecipientRole.SIGNER, () => <Trans>Signer</Trans>)
              .with(RecipientRole.CONTROLLED_SIGNER, () => <Trans>Controlled signer</Trans>)
              .with(RecipientRole.APPROVER, () => <Trans>Approver</Trans>)
              .with(RecipientRole.ASSISTANT, () => <Trans>Assistant</Trans>)
              .otherwise(() => null)}
          </Badge>
        </div>
      </div>

      {/* Right side - Desktop content */}
      <div className="hidden items-center space-x-2 lg:flex">
        <p className="mr-2 flex-shrink-0 text-muted-foreground text-sm">
          <Plural one="1 Field Remaining" other="# Fields Remaining" value={recipientFieldsRemaining.length} />
        </p>

        <EnvelopeSignerCompleteDialog />
      </div>

      {/* Mobile Actions button */}
      <div className="flex-shrink-0 lg:hidden">
        <MobileDropdownMenu />
      </div>
    </nav>
  );
};

const MobileDropdownMenu = () => {
  const { envelope, recipient } = useRequiredEnvelopeSigningContext();

  const { allowDocumentRejection } = useEmbedSigningContext() || {};
  const recipientCapabilities = getRecipientRoleCapabilities(recipient.role);

  const { sessionData } = useOptionalSession();

  // A restricted account is not offered a download control: the server refuses
  // every download route for it, so the action would only ever fail. The policy
  // of a token viewer does not carry their account, so the session decides here.
  const isDownloadBlockedForAccount = isRestrictedAccountViewer(sessionData?.user);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          <Trans>Actions</Trans>
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end">
        {recipientCapabilities.canDownload && !isDownloadBlockedForAccount && (
          <EnvelopeDownloadDialog
            envelopeId={envelope.id}
            envelopeStatus={envelope.status}
            envelopeItems={envelope.envelopeItems}
            token={recipient.token}
            trigger={
              <DropdownMenuItem asChild onSelect={(e) => e.preventDefault()}>
                <div>
                  <DownloadCloudIcon className="mr-2 h-4 w-4" />
                  <Trans>Download PDF</Trans>
                </div>
              </DropdownMenuItem>
            }
          />
        )}

        {envelope.type === EnvelopeType.DOCUMENT && allowDocumentRejection !== false && (
          <DocumentSigningRejectDialog
            documentId={mapSecondaryIdToDocumentId(envelope.secondaryId)}
            token={recipient.token}
            trigger={
              <DropdownMenuItem asChild onSelect={(e) => e.preventDefault()}>
                <div>
                  <BanIcon className="mr-2 h-4 w-4" />
                  <Trans>Reject</Trans>
                </div>
              </DropdownMenuItem>
            }
          />
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
