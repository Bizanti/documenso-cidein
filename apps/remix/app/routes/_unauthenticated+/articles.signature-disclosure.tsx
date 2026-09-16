import { SUPPORT_EMAIL } from '@documenso/lib/constants/app';
import { Button } from '@documenso/ui/primitives/button';
import { Trans } from '@lingui/react/macro';
import { Link } from 'react-router';

export default function SignatureDisclosure() {
  return (
    <div>
      <article className="prose dark:prose-invert">
        <h1>
          <Trans>Electronic Signature and Document Access Disclosure</Trans>
        </h1>

        <h2>
          <Trans>Purpose</Trans>
        </h2>
        <p>
          <Trans>
            This service allows you to review and sign documents by electronic means. By continuing with the signing
            process, you agree to use electronic means to perform the actions assigned to you by the sender.
          </Trans>
        </p>

        <h2>
          <Trans>Electronic signature and evidence</Trans>
        </h2>
        <p>
          <Trans>
            The system records information associated with the signing process, including the recipient, the actions
            performed and the available timestamps. These records form part of the electronic evidence of the process.
            The legal effects of an electronic signature depend on the applicable legislation, the type of document and
            the specific conditions of the transaction.
          </Trans>
        </p>

        <h2>
          <Trans>Identity and personal use</Trans>
        </h2>
        <p>
          <Trans>
            The access and authentication credentials assigned to each recipient are personal. You must not share
            passwords, codes, authenticated access links or any other factors used to confirm your identity.
          </Trans>
        </p>

        <h2>
          <Trans>Document access and document control</Trans>
        </h2>
        <p>
          <Trans>
            The ability to download, print, share or receive a copy of the final document depends on the access policy
            defined by the sender and by their document control system.
          </Trans>
        </p>
        <p>
          <Trans>
            Recipients designated as <strong>Controlled signer</strong> can review the document during the process and
            sign it, but they do not have functions to download or share the document through this flow, and the final
            PDF is not attached to their completion email. The finished document remains under the custody and document
            control of the sender. If you need a copy or later access, you must request it from the sender through their
            authorised procedures.
          </Trans>
        </p>

        <h2>
          <Trans>Electronic notifications</Trans>
        </h2>
        <p>
          <Trans>
            The system may send invitations, reminders and completion notices by email. Receiving a completion notice
            does not necessarily imply authorisation to download, share or receive the final document as an attachment.
          </Trans>
        </p>

        <h2>
          <Trans>Withdrawing consent before signing</Trans>
        </h2>
        <p>
          <Trans>
            If you do not wish to continue with electronic signing, contact the sender before completing your signature.
            The availability of an alternative procedure will depend on the sender and the requirements applicable to
            the document.
          </Trans>
        </p>

        <h2>
          <Trans>Retention and integrity</Trans>
        </h2>
        <p>
          <Trans>
            The sender is responsible for defining the retention periods, access controls and custody procedures
            applicable to their documents. Download restrictions do not replace the security, traceability, backup and
            retention controls of the corresponding document management system.
          </Trans>
        </p>

        <h2>
          <Trans>Acceptance</Trans>
        </h2>
        <p>
          <Trans>
            By continuing, you confirm that you have been able to access the document presented to you, that you
            understand the use of electronic means for this transaction, and that you will only perform the actions
            assigned to you.
          </Trans>
        </p>

        <h2>
          <Trans>Contact</Trans>
        </h2>
        <p>
          <Trans>
            If you have questions about this process or need to request access to a document, contact the sender. For
            technical assistance you can also write to <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
          </Trans>
        </p>
      </article>

      <div className="mt-8">
        <Button asChild>
          <Link to="/">
            <Trans>Back to home</Trans>
          </Link>
        </Button>
      </div>
    </div>
  );
}
