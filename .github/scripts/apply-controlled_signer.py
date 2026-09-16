from pathlib import Path


def read(path: str) -> str:
    return Path(path).read_text(encoding="utf-8")


def write(path: str, content: str) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")
    print(f"updated {path}")


def replace(path: str, old: str, new: str, count: int = 1) -> None:
    text = read(path)
    found = text.count(old)
    if found < count:
        raise RuntimeError(f"Expected at least {count} occurrence(s) in {path}, found {found}: {old[:100]!r}")
    write(path, text.replace(old, new, count))


def replace_all(path: str, old: str, new: str) -> None:
    text = read(path)
    found = text.count(old)
    if found == 0:
        raise RuntimeError(f"Expected occurrence in {path}: {old[:100]!r}")
    write(path, text.replace(old, new))


def replace_after(path: str, marker: str, old: str, new: str) -> None:
    text = read(path)
    if marker not in text:
        raise RuntimeError(f"Marker missing in {path}: {marker[:100]!r}")
    head, tail = text.split(marker, 1)
    if old not in tail:
        raise RuntimeError(f"Replacement target missing after marker in {path}: {old[:100]!r}")
    tail = tail.replace(old, new, 1)
    write(path, head + marker + tail)


# ---------------------------------------------------------------------------
# Database enum + migration
# ---------------------------------------------------------------------------
replace(
    "packages/prisma/schema.prisma",
    "enum RecipientRole {\n  CC\n  SIGNER\n  VIEWER\n  APPROVER\n  ASSISTANT\n}",
    "enum RecipientRole {\n  CC\n  SIGNER\n  CONTROLLED_SIGNER\n  VIEWER\n  APPROVER\n  ASSISTANT\n}",
)

write(
    "packages/prisma/migrations/20260916045000_add_controlled_signer_role/migration.sql",
    "-- AlterEnum\nALTER TYPE \"RecipientRole\" ADD VALUE 'CONTROLLED_SIGNER';\n",
)


# ---------------------------------------------------------------------------
# Central role semantics and capabilities
# ---------------------------------------------------------------------------
recipients_path = "packages/lib/utils/recipients.ts"
replace(
    recipients_path,
    "/**\n * Roles that require fields to be assigned before a document can be distributed.\n *\n * Currently only SIGNER requires a signature field.\n */\nexport const RECIPIENT_ROLES_THAT_REQUIRE_FIELDS = [RecipientRole.SIGNER] as const;",
    """export const isSigningRecipientRole = (role: RecipientRole) =>
  role === RecipientRole.SIGNER || role === RecipientRole.CONTROLLED_SIGNER;

export const getRecipientRoleCapabilities = (role: RecipientRole) => ({
  canSign: isSigningRecipientRole(role),
  canDownload: role !== RecipientRole.CONTROLLED_SIGNER,
  canShare: role !== RecipientRole.CONTROLLED_SIGNER,
  receivesCompletedPdf: role !== RecipientRole.CONTROLLED_SIGNER,
});

/**
 * Roles that require fields to be assigned before a document can be distributed.
 *
 * SIGNER and CONTROLLED_SIGNER recipients require a signature field.
 */
export const RECIPIENT_ROLES_THAT_REQUIRE_FIELDS = [
  RecipientRole.SIGNER,
  RecipientRole.CONTROLLED_SIGNER,
] as const;""",
)
replace(
    recipients_path,
    "    if (recipient.role === RecipientRole.SIGNER) {",
    "    if (isSigningRecipientRole(recipient.role)) {",
)
replace(
    recipients_path,
    " * Currently only SIGNERs are validated - they must have at least one signature field.",
    " * SIGNER and CONTROLLED_SIGNER recipients are validated - they must have at least one signature field.",
)


# ---------------------------------------------------------------------------
# Role descriptions / email semantics
# ---------------------------------------------------------------------------
roles_path = "packages/lib/constants/recipient-roles.ts"
controlled_role_description = """  [RecipientRole.CONTROLLED_SIGNER]: {
    actionVerb: msg({
      message: `Sign`,
      context: `Recipient role action verb`,
    }),
    actioned: msg({
      message: `Signed`,
      context: `Recipient role actioned`,
    }),
    progressiveVerb: msg({
      message: `Signing`,
      context: `Recipient role progressive verb`,
    }),
    roleName: msg({
      message: `Firmante controlado`,
      context: `Recipient role name`,
    }),
    roleNamePlural: msg({
      message: `Firmantes controlados`,
      context: `Recipient role plural name`,
    }),
  },
"""
replace(roles_path, "  [RecipientRole.VIEWER]: {", controlled_role_description + "  [RecipientRole.VIEWER]: {")
replace(
    roles_path,
    "  [RecipientRole.SIGNER]: `SIGNING_REQUEST`,\n  [RecipientRole.VIEWER]: `VIEW_REQUEST`,",
    "  [RecipientRole.SIGNER]: `SIGNING_REQUEST`,\n  [RecipientRole.CONTROLLED_SIGNER]: `SIGNING_REQUEST`,\n  [RecipientRole.VIEWER]: `VIEW_REQUEST`,",
)
replace(
    roles_path,
    "  [RecipientRole.SIGNER]: `SIGNING_REQUEST`,\n  [RecipientRole.VIEWER]: `VIEW_REQUEST`,",
    "  [RecipientRole.SIGNER]: `SIGNING_REQUEST`,\n  [RecipientRole.CONTROLLED_SIGNER]: `SIGNING_REQUEST`,\n  [RecipientRole.VIEWER]: `VIEW_REQUEST`,",
)
replace(
    roles_path,
    "  [RecipientRole.SIGNER]: msg`I am a signer of this document`,",
    "  [RecipientRole.SIGNER]: msg`I am a signer of this document`,\n  [RecipientRole.CONTROLLED_SIGNER]: msg`I am a controlled signer of this document`,",
)


# ---------------------------------------------------------------------------
# UI role icon and selector
# ---------------------------------------------------------------------------
replace(
    "packages/ui/primitives/recipient-role-icons.tsx",
    "  SIGNER: <PencilLine className=\"h-4 w-4\" />,",
    "  SIGNER: <PencilLine className=\"h-4 w-4\" />,\n  CONTROLLED_SIGNER: <PencilLine className=\"h-4 w-4\" />,")

role_select_path = "packages/ui/components/recipient/recipient-role-select.tsx"
controlled_select = """
        <SelectItem value={RecipientRole.CONTROLLED_SIGNER}>
          <div className="flex items-center">
            <div className="flex w-[150px] items-center">
              <span className="mr-2">{ROLE_ICONS[RecipientRole.CONTROLLED_SIGNER]}</span>
              <Trans>Firmante controlado</Trans>
            </div>
            <Tooltip>
              <TooltipTrigger>
                <InfoIcon className="h-4 w-4" />
              </TooltipTrigger>
              <TooltipContent className="z-9999 max-w-md p-4 text-foreground">
                <p>
                  <Trans>
                    Debe firmar el documento, pero no podrá descargarlo ni compartirlo y el PDF final no se adjuntará
                    al correo de finalización.
                  </Trans>
                </p>
              </TooltipContent>
            </Tooltip>
          </div>
        </SelectItem>

"""
replace(role_select_path, "        {!hideApproverRole && (", controlled_select + "        {!hideApproverRole && (")

# Recipient grouping maps must know the new enum member.
for path in [
    "packages/ui/primitives/recipient-selector.tsx",
    "packages/ui/primitives/document-flow/add-fields.tsx",
    "packages/ui/primitives/template-flow/add-template-fields.tsx",
    "apps/remix/app/components/general/envelope-editor/envelope-recipient-selector.tsx",
]:
    replace(
        path,
        "      SIGNER: [],\n      APPROVER: [],",
        "      SIGNER: [],\n      CONTROLLED_SIGNER: [],\n      APPROVER: [],",
    )

replace(
    "apps/remix/app/components/tables/admin-document-recipient-item-table.tsx",
    "  [RecipientRole.SIGNER]: 'Signer',\n  [RecipientRole.APPROVER]: 'Approver',",
    "  [RecipientRole.SIGNER]: 'Signer',\n  [RecipientRole.CONTROLLED_SIGNER]: 'Controlled signer',\n  [RecipientRole.APPROVER]: 'Approver',",
)

# Ensure the controlled signer can be selected for field assignment by default.
replace(
    "apps/remix/app/components/general/envelope-editor/envelope-editor-fields-page.tsx",
    "      (recipient) => recipient.role === RecipientRole.SIGNER || recipient.role === RecipientRole.APPROVER,",
    "      (recipient) =>\n        recipient.role === RecipientRole.SIGNER ||\n        recipient.role === RecipientRole.CONTROLLED_SIGNER ||\n        recipient.role === RecipientRole.APPROVER,",
)


# ---------------------------------------------------------------------------
# Signing UI: hide download for controlled signers
# ---------------------------------------------------------------------------
v2_path = "apps/remix/app/components/general/document-signing/document-signing-page-view-v2.tsx"
replace(
    v2_path,
    "import { mapSecondaryIdToDocumentId } from '@documenso/lib/utils/envelope';",
    "import { mapSecondaryIdToDocumentId } from '@documenso/lib/utils/envelope';\nimport { getRecipientRoleCapabilities } from '@documenso/lib/utils/recipients';",
)
replace(
    v2_path,
    "  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);",
    "  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);\n  const recipientCapabilities = getRecipientRoleCapabilities(recipient.role);",
)
replace(
    v2_path,
    ".with(RecipientRole.SIGNER, () => <Trans>Sign Document</Trans>)",
    ".with(RecipientRole.SIGNER, RecipientRole.CONTROLLED_SIGNER, () => <Trans>Sign Document</Trans>)",
)
old_v2_download = """                <EnvelopeDownloadDialog
                  envelopeId={envelope.id}
                  envelopeStatus={envelope.status}
                  envelopeItems={envelope.envelopeItems}
                  token={recipient.token}
                  trigger={
                    <Button variant="ghost" size="sm" className="w-full justify-start">
                      <DownloadCloudIcon className="mr-2 h-4 w-4" />
                      <Trans>Download PDF</Trans>
                    </Button>
                  }
                />
"""
new_v2_download = """                {recipientCapabilities.canDownload && (
                  <EnvelopeDownloadDialog
                    envelopeId={envelope.id}
                    envelopeStatus={envelope.status}
                    envelopeItems={envelope.envelopeItems}
                    token={recipient.token}
                    trigger={
                      <Button variant="ghost" size="sm" className="w-full justify-start">
                        <DownloadCloudIcon className="mr-2 h-4 w-4" />
                        <Trans>Download PDF</Trans>
                      </Button>
                    }
                  />
                )}
"""
replace(v2_path, old_v2_download, new_v2_download)

header_path = "apps/remix/app/components/general/envelope-signing/envelope-signer-header.tsx"
replace(
    header_path,
    "import { mapSecondaryIdToDocumentId } from '@documenso/lib/utils/envelope';",
    "import { mapSecondaryIdToDocumentId } from '@documenso/lib/utils/envelope';\nimport { getRecipientRoleCapabilities } from '@documenso/lib/utils/recipients';",
)
replace(
    header_path,
    "              .with(RecipientRole.SIGNER, () => <Trans>Signer</Trans>)",
    "              .with(RecipientRole.SIGNER, () => <Trans>Signer</Trans>)\n              .with(RecipientRole.CONTROLLED_SIGNER, () => <Trans>Firmante controlado</Trans>)",
)
replace(
    header_path,
    "  const { allowDocumentRejection } = useEmbedSigningContext() || {};",
    "  const { allowDocumentRejection } = useEmbedSigningContext() || {};\n  const recipientCapabilities = getRecipientRoleCapabilities(recipient.role);",
)
old_mobile_download = """        <EnvelopeDownloadDialog
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
"""
new_mobile_download = """        {recipientCapabilities.canDownload && (
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
"""
replace(header_path, old_mobile_download, new_mobile_download)

# Legacy signing view should present CONTROLLED_SIGNER exactly like a signer.
replace_all(
    "apps/remix/app/components/general/document-signing/document-signing-page-view-v1.tsx",
    ".with(RecipientRole.SIGNER, () =>",
    ".with(RecipientRole.SIGNER, RecipientRole.CONTROLLED_SIGNER, () =>",
)


# ---------------------------------------------------------------------------
# Completion page: hide share/download and show custody-aware copy
# ---------------------------------------------------------------------------
complete_path = "apps/remix/app/routes/_recipient+/sign.$token+/complete.tsx"
replace(
    complete_path,
    "import { isDocumentCompleted } from '@documenso/lib/utils/document';",
    "import { isDocumentCompleted } from '@documenso/lib/utils/document';\nimport { getRecipientRoleCapabilities, isSigningRecipientRole } from '@documenso/lib/utils/recipients';",
)
replace_after(
    complete_path,
    "  if (!isDocumentAccessValid) {",
    "  const isDirectTemplate = document.source === DocumentSource.TEMPLATE_DIRECT_LINK;",
    "  const recipientCapabilities = getRecipientRoleCapabilities(recipient.role);\n  const isControlledSigner = recipient.role === RecipientRole.CONTROLLED_SIGNER;\n\n  const isDirectTemplate = document.source === DocumentSource.TEMPLATE_DIRECT_LINK;",
)
replace(
    complete_path,
    "              {recipient.role === RecipientRole.SIGNER && <Trans>Document Signed</Trans>}",
    "              {isSigningRecipientRole(recipient.role) && <Trans>Document Signed</Trans>}",
)
replace(
    complete_path,
    "                      <Trans>Everyone has signed! You will receive an email copy of the signed document.</Trans>",
    "                      {isControlledSigner ? (\n                        <Trans>El documento ha finalizado y permanecerá bajo el control documental del remitente.</Trans>\n                      ) : (\n                        <Trans>Everyone has signed! You will receive an email copy of the signed document.</Trans>\n                      )}",
)
replace(
    complete_path,
    "                      <Trans>\n                        All recipients have signed. The document is being processed and you will receive an email copy\n                        shortly.\n                      </Trans>",
    "                      {isControlledSigner ? (\n                        <Trans>\n                          Todos los destinatarios han firmado. El documento se está procesando y permanecerá bajo el\n                          control documental del remitente.\n                        </Trans>\n                      ) : (\n                        <Trans>\n                          All recipients have signed. The document is being processed and you will receive an email copy\n                          shortly.\n                        </Trans>\n                      )}",
)
replace(
    complete_path,
    "                    <Trans>You will receive an email copy of the signed document once everyone has signed.</Trans>",
    "                    {isControlledSigner ? (\n                      <Trans>Tu firma ha finalizado. Recibirás una notificación cuando el documento esté completo.</Trans>\n                    ) : (\n                      <Trans>You will receive an email copy of the signed document once everyone has signed.</Trans>\n                    )}",
)
old_share = """            <DocumentShareButton
              documentId={document.id}
              token={recipient.token}
              className="dark:bg-muted dark:hover:bg-muted/80"
            />
"""
new_share = """            {recipientCapabilities.canShare && (
              <DocumentShareButton
                documentId={document.id}
                token={recipient.token}
                className="dark:bg-muted dark:hover:bg-muted/80"
              />
            )}
"""
replace(complete_path, old_share, new_share)
replace(
    complete_path,
    "            {isDocumentCompleted(document) && (",
    "            {recipientCapabilities.canDownload && isDocumentCompleted(document) && (",
)


# ---------------------------------------------------------------------------
# Backend: recipient-token download and share restrictions
# ---------------------------------------------------------------------------
files_path = "apps/remix/server/api/files/files.ts"
replace(
    files_path,
    "import type { Prisma } from '@prisma/client';",
    "import { RecipientRole, type Prisma } from '@prisma/client';",
)
replace_after(
    files_path,
    "    '/token/:token/envelopeItem/:envelopeItemId/download/:version?',",
    "      if (!envelopeItem.documentData) {\n        return c.json({ error: 'Document data not found' }, 404);\n      }",
    """      if (!token.startsWith('qr_')) {
        const recipient = await prisma.recipient.findFirst({
          where: {
            token,
            envelopeId: envelopeItem.envelopeId,
          },
          select: {
            role: true,
          },
        });

        if (recipient?.role === RecipientRole.CONTROLLED_SIGNER) {
          return c.json({ error: 'Controlled signers are not permitted to download this document' }, 403);
        }
      }

      if (!envelopeItem.documentData) {
        return c.json({ error: 'Document data not found' }, 404);
      }""",
)

share_path = "packages/lib/server-only/share/create-or-get-share-link.ts"
replace(
    share_path,
    "import { EnvelopeType } from '@prisma/client';",
    "import { EnvelopeType, RecipientRole } from '@prisma/client';",
)
old_token_share = """    .with({ token: P.string }, async ({ token }) => {
      return await prisma.recipient
        .findFirst({
          where: {
            envelopeId: envelope.id,
            token,
          },
        })
        .then((recipient) => recipient?.email);
    })
"""
new_token_share = """    .with({ token: P.string }, async ({ token }) => {
      const recipient = await prisma.recipient.findFirst({
        where: {
          envelopeId: envelope.id,
          token,
        },
        select: {
          email: true,
          role: true,
        },
      });

      if (recipient?.role === RecipientRole.CONTROLLED_SIGNER) {
        throw new AppError(AppErrorCode.FORBIDDEN, {
          message: 'Controlled signers are not permitted to create document share links',
        });
      }

      return recipient?.email;
    })
"""
replace(share_path, old_token_share, new_token_share)


# ---------------------------------------------------------------------------
# Completion email: notification yes, final PDF/download no for controlled role
# ---------------------------------------------------------------------------
email_component_path = "packages/email/template-components/template-document-completed.tsx"
replace(
    email_component_path,
    "  customBody?: string;\n}",
    "  customBody?: string;\n  allowDownload?: boolean;\n}",
)
replace(
    email_component_path,
    "  customBody,\n}: TemplateDocumentCompletedProps) => {",
    "  customBody,\n  allowDownload = true,\n}: TemplateDocumentCompletedProps) => {",
)
old_email_action = """        <Text className="my-1 text-center text-base text-muted-foreground">
          <Trans>Continue by downloading the document.</Trans>
        </Text>

        <Section className="mt-8 mb-6 text-center">
          <Button
            className="rounded-lg border border-border border-solid px-4 py-2 text-center font-medium text-foreground text-sm no-underline"
            href={downloadLink}
          >
            <Img src={getAssetUrl('/static/download.png')} className="mr-2 mb-0.5 inline h-5 w-5 align-middle" alt="" />
            <Trans>Download</Trans>
          </Button>
        </Section>
"""
new_email_action = """        {allowDownload ? (
          <>
            <Text className="my-1 text-center text-base text-muted-foreground">
              <Trans>Continue by downloading the document.</Trans>
            </Text>

            <Section className="mt-8 mb-6 text-center">
              <Button
                className="rounded-lg border border-border border-solid px-4 py-2 text-center font-medium text-foreground text-sm no-underline"
                href={downloadLink}
              >
                <Img
                  src={getAssetUrl('/static/download.png')}
                  className="mr-2 mb-0.5 inline h-5 w-5 align-middle"
                  alt=""
                />
                <Trans>Download</Trans>
              </Button>
            </Section>
          </>
        ) : (
          <Text className="my-4 text-center text-base text-muted-foreground">
            <Trans>
              El proceso de firma ha finalizado. El documento permanece bajo el control documental del remitente y no se
              adjunta a este correo.
            </Trans>
          </Text>
        )}
"""
replace(email_component_path, old_email_action, new_email_action)

email_template_path = "packages/email/templates/document-completed.tsx"
replace(
    email_template_path,
    "  customBody,\n  reportUrl,\n}: DocumentCompletedEmailTemplateProps) => {",
    "  customBody,\n  reportUrl,\n  allowDownload = true,\n}: DocumentCompletedEmailTemplateProps) => {",
)
replace(
    email_template_path,
    "                customBody={customBody}\n              />",
    "                customBody={customBody}\n                allowDownload={allowDownload}\n              />",
)

handler_path = "packages/lib/jobs/definitions/emails/send-document-completed-emails.handler.ts"
replace(
    handler_path,
    "    recipientsToNotify.map(async (recipient) => {",
    "    recipientsToNotify.map(async (recipient) => {\n      const isControlledSigner = recipient.role === RecipientRole.CONTROLLED_SIGNER;",
)
replace_after(
    handler_path,
    "    recipientsToNotify.map(async (recipient) => {",
    "        reportUrl,\n      });",
    "        reportUrl,\n        allowDownload: !isControlledSigner,\n      });",
)
replace_after(
    handler_path,
    "    recipientsToNotify.map(async (recipient) => {",
    "        attachments: completedDocumentEmailAttachments,",
    "        attachments: isControlledSigner ? [] : completedDocumentEmailAttachments,",
)


# ---------------------------------------------------------------------------
# Invitation/reminder emails and signer presentation
# ---------------------------------------------------------------------------
for path in [
    "packages/email/template-components/template-document-invite.tsx",
    "packages/email/template-components/template-document-reminder.tsx",
]:
    replace_all(
        path,
        ".with(RecipientRole.SIGNER, () =>",
        ".with(RecipientRole.SIGNER, RecipientRole.CONTROLLED_SIGNER, () =>",
    )


# ---------------------------------------------------------------------------
# Disclosure page: CIDEIN controlled-document wording without promising a copy
# ---------------------------------------------------------------------------
disclosure = """import { SUPPORT_EMAIL } from '@documenso/lib/constants/app';
import { Button } from '@documenso/ui/primitives/button';
import { Link } from 'react-router';

export default function SignatureDisclosure() {
  return (
    <div>
      <article className="prose dark:prose-invert">
        <h1>Divulgación sobre firma electrónica y acceso al documento</h1>

        <h2>Finalidad</h2>
        <p>
          Este servicio permite revisar y firmar documentos por medios electrónicos. Al continuar con el proceso de
          firma, aceptas utilizar medios electrónicos para realizar las acciones que el remitente te haya asignado.
        </p>

        <h2>Firma electrónica y evidencia</h2>
        <p>
          El sistema registra información asociada al proceso de firma, incluyendo el destinatario, las acciones
          realizadas y las marcas de tiempo disponibles. Estos registros forman parte de la evidencia electrónica del
          proceso. Los efectos jurídicos de una firma electrónica dependen de la legislación aplicable, del tipo de
          documento y de las condiciones concretas de la operación.
        </p>

        <h2>Identidad y uso personal</h2>
        <p>
          Los medios de acceso y autenticación asignados a cada destinatario son personales. No debes compartir
          contraseñas, códigos, enlaces de acceso autenticado ni otros factores utilizados para confirmar tu identidad.
        </p>

        <h2>Acceso al documento y control documental</h2>
        <p>
          La posibilidad de descargar, imprimir, compartir o recibir una copia del documento final depende de la política
          de acceso definida por el remitente y por su sistema de control documental.
        </p>
        <p>
          Los destinatarios designados como <strong>Firmante controlado</strong> pueden revisar el documento durante el
          proceso y realizar su firma, pero no disponen de funciones para descargar o compartir el documento mediante
          este flujo y el PDF final no se adjunta a su correo de finalización. El documento terminado permanece bajo la
          custodia y el control documental del remitente. Si necesitas una copia o acceso posterior, deberás solicitarlo
          al remitente conforme a sus procedimientos autorizados.
        </p>

        <h2>Notificaciones electrónicas</h2>
        <p>
          El sistema puede enviar por correo electrónico invitaciones, recordatorios y avisos de finalización. Recibir un
          aviso de finalización no implica necesariamente autorización para descargar, compartir o recibir como adjunto
          el documento final.
        </p>

        <h2>Retiro del consentimiento antes de firmar</h2>
        <p>
          Si no deseas continuar mediante firma electrónica, comunícate con el remitente antes de completar tu firma. La
          disponibilidad de un procedimiento alternativo dependerá del remitente y de los requisitos aplicables al
          documento.
        </p>

        <h2>Conservación e integridad</h2>
        <p>
          El remitente es responsable de definir los periodos de conservación, controles de acceso y procedimientos de
          custodia aplicables a sus documentos. Las restricciones de descarga no sustituyen los controles de seguridad,
          trazabilidad, respaldo y conservación que correspondan al sistema de gestión documental.
        </p>

        <h2>Aceptación</h2>
        <p>
          Al continuar, confirmas que has podido acceder al documento que se te presenta, que comprendes el uso de medios
          electrónicos para esta operación y que realizarás únicamente las acciones que te han sido asignadas.
        </p>

        <h2>Contacto</h2>
        <p>
          Si tienes dudas sobre este proceso o necesitas solicitar acceso a un documento, comunícate con el remitente. Para
          asistencia técnica también puedes escribir a <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
        </p>
      </article>

      <div className="mt-8">
        <Button asChild>
          <Link to="/">Volver al inicio</Link>
        </Button>
      </div>
    </div>
  );
}
"""
write("apps/remix/app/routes/_unauthenticated+/articles.signature-disclosure.tsx", disclosure)

print("Controlled signer production patch applied successfully.")
