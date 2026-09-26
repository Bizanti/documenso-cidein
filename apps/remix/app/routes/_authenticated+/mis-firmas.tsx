import { getOptionalSession } from '@documenso/auth/server/lib/utils/get-session';
import { Button } from '@documenso/ui/primitives/button';
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { SigningStatus } from '@prisma/client';
import { ClockIcon, HourglassIcon, PenLineIcon, SignatureIcon } from 'lucide-react';
import { DateTime } from 'luxon';
import type { ComponentType, ReactNode } from 'react';
import { Link, redirect } from 'react-router';

import { appMetaTags } from '~/utils/meta';
import { findSigningInbox, type SigningInboxDocument } from '~/utils/mis-firmas.server';
import { superLoaderJson, useSuperLoaderData } from '~/utils/super-json-loader';

import type { Route } from './+types/mis-firmas';

export function meta() {
  return appMetaTags(msg`My signatures`);
}

export async function loader({ request }: Route.LoaderArgs) {
  const { user } = await getOptionalSession(request);

  if (!user) {
    throw redirect('/signin');
  }

  return superLoaderJson({
    signingInbox: await findSigningInbox({ userId: user.id }),
  });
}

export default function MisFirmasPage() {
  const { _ } = useLingui();

  const { signingInbox } = useSuperLoaderData<typeof loader>();

  return (
    <div className="mx-auto w-full max-w-screen-xl px-4 md:px-8" data-testid="mis-firmas-page">
      <div className="mb-8">
        <h1 className="flex flex-row items-center gap-2 font-bold text-3xl">
          <PenLineIcon className="h-8 w-8 text-muted-foreground" />

          <Trans>My signatures</Trans>
        </h1>
        <p className="mt-1 text-muted-foreground">
          <Trans>Documents which have been shared with you to sign.</Trans>
        </p>
      </div>

      <div className="flex flex-col gap-y-10">
        <SigningSection
          testId="mis-firmas-pending"
          icon={SignatureIcon}
          title={msg`Pending`}
          description={msg`These documents are waiting for your signature.`}
          emptyMessage={msg`You have no documents waiting for your signature.`}
          documents={signingInbox.pending}
          renderAction={(document) => (
            <Button asChild>
              <Link to={`/sign/${document.signingToken}`} data-testid="mis-firmas-sign-link">
                <Trans>Sign</Trans>
              </Link>
            </Button>
          )}
        />

        <SigningSection
          testId="mis-firmas-waiting"
          icon={HourglassIcon}
          title={msg`Waiting`}
          description={msg`These documents are assigned to you, but it is not your turn to sign yet.`}
          emptyMessage={msg`You have no documents waiting for their turn.`}
          documents={signingInbox.waiting}
        />

        <SigningSection
          testId="mis-firmas-history"
          icon={ClockIcon}
          title={msg`History`}
          description={msg`Documents you have already signed or rejected.`}
          emptyMessage={msg`You have not signed any documents yet.`}
          documents={signingInbox.completed}
          renderMetadata={(document) => {
            const isSigned = document.recipientStatus === SigningStatus.SIGNED;

            return (
              <span
                className={
                  isSigned ? 'text-green-600 text-sm dark:text-green-300' : 'text-red-600 text-sm dark:text-red-300'
                }
                data-testid="mis-firmas-history-status"
              >
                {isSigned ? _(msg`Signed`) : _(msg`Rejected`)}
              </span>
            );
          }}
        />
      </div>
    </div>
  );
}

type SigningSectionProps = {
  testId: string;
  title: MessageDescriptor;
  description: MessageDescriptor;
  emptyMessage: MessageDescriptor;
  icon: ComponentType<{ className?: string }>;
  documents: SigningInboxDocument[];
  renderAction?: (_document: SigningInboxDocument) => ReactNode;
  renderMetadata?: (_document: SigningInboxDocument) => ReactNode;
};

const SigningSection = ({
  testId,
  title,
  description,
  emptyMessage,
  icon: Icon,
  documents,
  renderAction,
  renderMetadata,
}: SigningSectionProps) => {
  const { _, i18n } = useLingui();

  return (
    <section data-testid={testId}>
      <h2 className="flex flex-row items-center gap-2 font-semibold text-xl">
        <Icon className="h-5 w-5 text-muted-foreground" />

        {_(title)}

        {documents.length > 0 && (
          <span className="flex h-6 min-w-[1.5rem] items-center justify-center rounded-full bg-muted px-1.5 font-medium text-muted-foreground text-xs">
            {documents.length}
          </span>
        )}
      </h2>

      <p className="mt-1 text-muted-foreground text-sm">{_(description)}</p>

      {documents.length === 0 ? (
        <p className="mt-4 rounded-lg border border-dashed p-6 text-center text-muted-foreground text-sm">
          {_(emptyMessage)}
        </p>
      ) : (
        <ul className="mt-4 flex flex-col gap-y-3">
          {documents.map((document) => (
            <li
              key={document.id}
              className="flex flex-col gap-3 rounded-lg border p-4 md:flex-row md:items-center md:justify-between"
              data-testid="mis-firmas-document"
            >
              <div className="min-w-0 space-y-1">
                <p className="truncate font-medium">{document.title}</p>

                <div className="flex flex-wrap items-center gap-x-2 text-muted-foreground text-sm">
                  <span className="truncate">
                    <Trans>From {document.senderName}</Trans>
                  </span>

                  <span aria-hidden="true">·</span>

                  <span className="tabular-nums">
                    {i18n.date(document.createdAt, { ...DateTime.DATETIME_SHORT, hourCycle: 'h12' })}
                  </span>
                </div>

                {renderMetadata?.(document)}
              </div>

              {renderAction && <div className="flex shrink-0 items-center">{renderAction(document)}</div>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};
