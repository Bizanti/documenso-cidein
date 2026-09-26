/**
 * Regression checks for the "My signatures" classification rules.
 *
 * apps/remix has no test runner, so this runs straight through the `tsx` dev dependency:
 *
 *   cd apps/remix && npx tsx app/utils/mis-firmas-rules.verify.ts
 *
 * It is never imported by application code, it only guards the edge cases which are easy to
 * break while editing `mis-firmas-rules.ts`.
 */
import { DocumentSigningOrder, DocumentStatus, RecipientRole, SigningStatus } from '@prisma/client';

import {
  getIsRecipientTurn,
  getSigningInboxSection,
  isActionableRecipient,
  type SigningInboxRecipient,
} from './mis-firmas-rules';

let failures = 0;

const check = (name: string, actual: unknown, expected: unknown) => {
  const passed = JSON.stringify(actual) === JSON.stringify(expected);

  if (!passed) {
    failures += 1;
  }

  console.log(
    `${passed ? 'ok  ' : 'FAIL'} ${name}${passed ? '' : ` -> expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`,
  );
};

const recipient = (
  id: number,
  role: RecipientRole,
  signingStatus: SigningStatus,
  signingOrder: number | null = null,
): SigningInboxRecipient => ({ id, email: `recipient-${id}@example.com`, role, signingOrder, signingStatus });

const section = (
  documentStatus: DocumentStatus,
  recipientRow: SigningInboxRecipient,
  recipients: SigningInboxRecipient[],
  signingOrder: DocumentSigningOrder | null = null,
) => getSigningInboxSection({ documentStatus, signingOrder, recipients, recipient: recipientRow });

// Roles which can never act are left out of the inbox entirely.
check('VIEWER is not an actionable recipient', isActionableRecipient({ role: RecipientRole.VIEWER }), false);
check('CC is not an actionable recipient', isActionableRecipient({ role: RecipientRole.CC }), false);
check('SIGNER is actionable', isActionableRecipient({ role: RecipientRole.SIGNER }), true);
check('CONTROLLED_SIGNER is actionable', isActionableRecipient({ role: RecipientRole.CONTROLLED_SIGNER }), true);
check('APPROVER is actionable', isActionableRecipient({ role: RecipientRole.APPROVER }), true);
check('ASSISTANT is actionable', isActionableRecipient({ role: RecipientRole.ASSISTANT }), true);

// A document which can no longer be signed is never offered as something to act on.
const notSignedSigner = recipient(1, RecipientRole.SIGNER, SigningStatus.NOT_SIGNED, 1);
const onlyMe = [notSignedSigner];

check('NOT_SIGNED on REJECTED -> not listed', section(DocumentStatus.REJECTED, notSignedSigner, onlyMe), 'none');
check('NOT_SIGNED on CANCELLED -> not listed', section(DocumentStatus.CANCELLED, notSignedSigner, onlyMe), 'none');
check('NOT_SIGNED on COMPLETED -> not listed', section(DocumentStatus.COMPLETED, notSignedSigner, onlyMe), 'none');
check('NOT_SIGNED on DRAFT -> not listed', section(DocumentStatus.DRAFT, notSignedSigner, onlyMe), 'none');

// Documents which are still waiting on signatures.
const sequential = DocumentSigningOrder.SEQUENTIAL;

check(
  'NOT_SIGNED on PENDING (parallel) -> pending',
  section(DocumentStatus.PENDING, notSignedSigner, onlyMe),
  'pending',
);
check(
  'NOT_SIGNED on PENDING without documentMeta -> pending (parallel by default)',
  section(DocumentStatus.PENDING, notSignedSigner, onlyMe, null),
  'pending',
);

const earlierUnsigned = recipient(2, RecipientRole.SIGNER, SigningStatus.NOT_SIGNED, 1);
const secondSigner = recipient(1, RecipientRole.SIGNER, SigningStatus.NOT_SIGNED, 2);

check(
  'SEQUENTIAL with an earlier unsigned signer -> waiting',
  section(DocumentStatus.PENDING, secondSigner, [earlierUnsigned, secondSigner], sequential),
  'waiting',
);
check(
  'SEQUENTIAL with an earlier unsigned signer -> waiting (unsorted input)',
  section(DocumentStatus.PENDING, secondSigner, [secondSigner, earlierUnsigned], sequential),
  'waiting',
);

const earlierSigned = recipient(3, RecipientRole.SIGNER, SigningStatus.SIGNED, 1);

check(
  'SEQUENTIAL with an earlier signed signer -> pending',
  section(DocumentStatus.PENDING, secondSigner, [earlierSigned, secondSigner], sequential),
  'pending',
);

const ccFirst = recipient(4, RecipientRole.CC, SigningStatus.NOT_SIGNED, null);

check(
  'SEQUENTIAL with an earlier CC which never signs -> pending',
  section(DocumentStatus.PENDING, secondSigner, [ccFirst, secondSigner], sequential),
  'pending',
);

const approver = recipient(1, RecipientRole.APPROVER, SigningStatus.NOT_SIGNED, 1);

check('APPROVER on PENDING -> pending', section(DocumentStatus.PENDING, approver, [approver]), 'pending');

// The history reports the state of the user's own signature, whatever the document did next.
const signedMe = recipient(1, RecipientRole.SIGNER, SigningStatus.SIGNED, 1);
const rejectedMe = recipient(1, RecipientRole.SIGNER, SigningStatus.REJECTED, 1);

check('SIGNED on COMPLETED -> completed', section(DocumentStatus.COMPLETED, signedMe, [signedMe]), 'completed');
check('SIGNED on REJECTED -> completed', section(DocumentStatus.REJECTED, signedMe, [signedMe]), 'completed');
check('SIGNED on CANCELLED -> completed', section(DocumentStatus.CANCELLED, signedMe, [signedMe]), 'completed');
check('REJECTED on REJECTED -> completed', section(DocumentStatus.REJECTED, rejectedMe, [rejectedMe]), 'completed');
check('SIGNED on PENDING -> completed', section(DocumentStatus.PENDING, signedMe, [signedMe]), 'completed');

// Defensive: a recipient which is not part of the document can never be the current turn.
const stranger = recipient(5, RecipientRole.SIGNER, SigningStatus.NOT_SIGNED, 1);

check(
  'recipient missing from the list -> not their turn',
  getIsRecipientTurn({ recipients: [secondSigner], recipient: stranger, signingOrder: sequential }),
  false,
);
check(
  'recipient missing from the list on a pending sequential document -> waiting',
  section(DocumentStatus.PENDING, stranger, [secondSigner], sequential),
  'waiting',
);

console.log(failures === 0 ? '\nALL PASS' : `\nFAILURES: ${failures}`);

process.exit(failures === 0 ? 0 : 1);
