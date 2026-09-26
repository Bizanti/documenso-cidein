# E2E del perfil SIGN_ONLY (M30)

Escenarios de extremo a extremo del perfil restringido (`Role.SIGN_ONLY`), tal como quedó
implementado por M25–M29 y por los cierres residuales M31 (descarga) y M32 (lecturas).

Cada escenario tiene identificador, resultado esperado y el spec que lo cubre. Los que no se
pueden cubrir hoy quedan enumerados con el motivo exacto.

## Escenarios cubiertos

| Id  | Resultado esperado                                                                                                          | Spec                                        |
| --- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| A1  | Alta por email → `roles: [SIGN_ONLY]`, sin organización/team personal, aterriza en `/mis-firmas` con menú reducido           | `sign-only-onboarding.spec.ts`              |
| A3  | Alta invitada por invitación de organización: se crea la cuenta por el wizard, acepta la invitación, sigue restringida y sin espacio personal | `sign-only-onboarding.spec.ts`              |
| A4  | El firmante SIGN_ONLY abre su bandeja, entra a `/sign/{token}` desde el enlace de la bandeja y firma de verdad; el documento pasa a `COMPLETED` y aparece en Historial como `Signed` | `sign-only-signing.spec.ts`                 |
| A5  | Cuenta sin ninguna organización inicia sesión, aterriza en `/mis-firmas`, recarga sin errores, conserva `/settings/profile` y `/settings/security` y no alcanza `/t/*`, `/settings/billing`, `/settings/organisations` ni `/admin/*` | `sign-only-onboarding.spec.ts`              |
| B   | Bandeja: un documento detrás de un firmante real va a **En espera** (sin enlace de firma); detrás de un CC ya está en **Pendientes**; lo ya firmado va a **Historial** | `sign-only-signing.spec.ts`                 |
| C1  | Crear documento bloqueado: UI (área de equipo inalcanzable y sin control de subida en la bandeja) y API directa (`POST /api/v2-beta/envelope/create` y `POST /api/v1/documents/:id/send` → 403 con el mensaje de cuenta restringida) | `sign-only-restrictions.spec.ts`            |
| C2  | Carpetas, plantillas y duplicado bloqueados por API (`folder/create`, `envelope/create` tipo TEMPLATE, `envelope/duplicate` → 403) y UI (`/documents/folders`, `/templates` → bandeja); nada se crea | `sign-only-restrictions.spec.ts`            |
| C3  | Crear equipo u organización bloqueado: UI (`/settings/organisations`, `/o/*/settings/teams` → bandeja) y tRPC `team.create` / `organisation.create` → 403 | `sign-only-restrictions.spec.ts`            |
| D1  | Miembro de un equipo compartido no ve los documentos del equipo: el área de equipo redirige, la bandeja sólo lista lo dirigido a la cuenta y las lecturas del equipo se rechazan (tRPC `document.find` / `envelope.get` y `GET /api/v2/envelope[/{id}]` → 403, sin filtrar título) | `sign-only-isolation.spec.ts`               |
| D2  | URL con ids manipulados (documento ajeno bajo el propio equipo, otro equipo, otra organización, propia organización, admin) → bandeja | `sign-only-isolation.spec.ts`               |
| D3  | Invitado como MEMBER intenta subir: sesión propia con `envelope.create` → 403 y sin control de subida | `sign-only-isolation.spec.ts`               |
| E1  | Un firmante CONTROLADO (regresión) sigue sin descarga: regla `canDownloadDocument` y ruta de descarga por token → 403. Cobertura amplia en `e2e/api/v2/controlled-signer-file-access.spec.ts` | `sign-only-downloads.spec.ts`               |
| E2  | Firmante con cuenta SIGN_ONLY no descarga en ninguna superficie: sesión (firmado y original) → 403, token de destinatario → 403, API v1 → 403, la política que consume la UI oculta ambas versiones (con sesión y con token) y la regla de adjunto por destinatario devuelve `false` | `sign-only-downloads.spec.ts`               |
| E3  | Cuenta SIGN_ONLY con privilegios SGC (rol de equipo SGC verificado en BD) tampoco descarga: mismas rutas → 403 y política oculta | `sign-only-downloads.spec.ts`               |
| E4  | Ver no es descargar: la cuenta restringida abre el visor del documento que firma (`…/dataId/{id}/current/item.pdf` → 200 `application/pdf`) mientras la descarga sigue en 403 | `sign-only-downloads.spec.ts`               |
| F1  | Promoción SIGN_ONLY→USER desde `/admin/users/{id}` efectiva en la siguiente petición: el token API previo deja de recibir 403 y la carpeta se crea; no se crea organización personal | `sign-only-profile-changes.spec.ts`         |
| F2  | Degradación USER→SIGN_ONLY con sesión y token previos: la sesión se invalida (redirige a `/signin`) y el token recibe 403 en su siguiente escritura, sin crear nada | `sign-only-profile-changes.spec.ts`         |
| F3  | USER promovido sin organización personal trabaja en el equipo asignado: inicia sesión, aterriza en `/t/{team}/documents`, el control de subida existe y su token crea una carpeta en ese equipo | `sign-only-profile-changes.spec.ts`         |
| G1  | Un administrador conserva sus funciones: aterriza en su equipo, sube un documento por la UI (queda en `PENDING`/editor), crea un equipo y entra al panel `/admin/users` | `sign-only-regressions.spec.ts`             |
| G2  | Un destinatario externo sin cuenta se rige por su rol: `canAttachDocumentPdfToAddressee` → `true` y descarga por token → 200 | `sign-only-downloads.spec.ts`               |
| G3  | Una cuenta `[USER]` existente conserva acceso completo: sesión válida, `/t/{team}/documents` con control de subida y su token crea una carpeta | `sign-only-regressions.spec.ts`             |

## Escenarios fuera de la suite y por qué

| Id | Motivo                                                                                                                                                                                                                                                                             |
| -- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A2 | Alta por SSO. Requiere un proveedor de identidad OIDC real; no hay harness que lo simule en `packages/app-tests`. La regla (toda alta entrega el perfil restringido) queda cubierta por A1/A3 y por los tests unitarios de `create-user` y `handle-oauth-organisation-callback-url`. Test marcado con `test.skip` en `sign-only-onboarding.spec.ts`. |
| E5 | "Correo encolado antes de la restricción, enviado después → aplica la política vigente al momento del envío". Es cobertura de jobs (`send-document-completed-emails`), con tests unitarios en M26; la suite no puede controlar cuándo se envía un correo ya encolado.                                                                                                                                              |
| B (transición espera→pendiente) | Se cubre la clasificación (espera, pendiente, historial) pero no la transición tras firmar el firmante anterior: exige una segunda sesión de firma con otro destinatario. Documentado aquí en vez de improvisarlo.                                                                              |

## Dependencias de merge (M31 / M32)

Los specs se apoyan en dos cierres que aterrizan antes que esta rama:

- **M31** (descarga residual): la descarga por token de destinatario resuelve la cuenta y deniega
  con `ACCOUNT_DOWNLOAD_FORBIDDEN`. De ahí las aserciones de E2 por token y las dos llamadas a la
  política (con sesión y con token).
- **M32** (lecturas aisladas): las queries de ámbito equipo/organización se rechazan para cuentas
  restringidas. De ahí las aserciones de lectura de D1 (`document.find`, `envelope.get`,
  `GET /api/v2/envelope[/{id}]`), con la salvedad de que en la superficie de sesión el cuerpo lleve
  el `FORBIDDEN` aunque el HTTP sea 200; los helpers lo aceptan.

Fuera de esos dos cierres, la única desviación conocida que queda documentada es:

- **Adjunto de E2.** No hay captura de correo en la suite, así que la mitad "ni adjunto" se afirma
  contra `canAttachDocumentPdfToAddressee` (la función que consultan los envíos), no contra un
  correo real.

## Cómo ejecutar

Requisitos: Postgres accesible, `DATABASE_URL` en `.env`, migraciones aplicadas y la app levantada
(o usar `npm run test:e2e`, que arranca el servidor). Los paths de Playwright se resuelven desde
`packages/app-tests`.

```bash
# Todo el bloque SIGN_ONLY (proyecto ui)
npm run test:e2e -- --project=ui e2e/sign-only

# Un escenario concreto
E2E_TEST_PATH=e2e/sign-only/sign-only-onboarding.spec.ts npm run test:e2e

# En modo dev contra un servidor ya levantado
npm run test:dev -w @documenso/app-tests -- --project=ui e2e/sign-only

# Sólo listar (comprueba que los specs compilan y se recolectan)
NODE_OPTIONS='--import tsx' npx playwright test --list --project=ui e2e/sign-only
```

## Notas de implementación

- `e2e/fixtures/sign-only.ts` concentra el sembrado del perfil: `seedUser` de
  `@documenso/prisma/seed/users` siempre crea `[USER]` con organización personal, así que no sirve
  para una cuenta restringida. Los helpers crean `roles: [SIGN_ONLY]` sin espacio personal, añaden
  al miembro a organización/equipo y emiten tokens API.
- A1/A3 usan el alta real por UI (`/signup` + verificación de email) porque el perfil por defecto
  es justamente lo que se está probando.
- Los mensajes de rechazo (`RESTRICTED_ACCOUNT_MESSAGE`, `RESTRICTED_ACCOUNT_DOWNLOAD_MESSAGE`) se
  afirman junto al 403 para no confundir el bloqueo por perfil con un 403 de permisos de equipo.
- Las mutaciones tRPC sin endpoint público (`team.create`, `organisation.create`,
  `admin.user.update`, `envelope.create`) se llaman por `POST /api/trpc/<ruta>` con la sesión de la
  página, en el formato superjson no batcheado que usan los helpers de consulta existentes.
