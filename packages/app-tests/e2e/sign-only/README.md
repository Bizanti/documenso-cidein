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
| B   | Bandeja: un documento detrás de un firmante real va a **En espera** (sin enlace de firma); detrás de un CC ya está en **Pendientes**; lo ya firmado va a **Historial**. Y la transición: cuando el firmante anterior firma desde su propio contexto, el documento pasa de **En espera a Pendientes** y ya ofrece enlace de firma | `sign-only-signing.spec.ts`                 |
| C1  | Crear documento bloqueado: UI (área de equipo inalcanzable y sin control de subida en la bandeja) y API directa (`POST /api/v2-beta/envelope/create` y `POST /api/v1/documents/:id/send` → 403 con el mensaje de cuenta restringida) | `sign-only-restrictions.spec.ts`            |
| C2  | Carpetas, plantillas y duplicado bloqueados por API (`folder/create`, `envelope/create` tipo TEMPLATE, `envelope/duplicate` → 403) y UI (`/documents/folders`, `/templates` → bandeja); nada se crea | `sign-only-restrictions.spec.ts`            |
| C3  | Crear equipo u organización bloqueado: UI (`/settings/organisations`, `/o/*/settings/teams` → bandeja) y tRPC `team.create` / `organisation.create` → 403 | `sign-only-restrictions.spec.ts`            |
| D1  | Miembro de un equipo compartido no ve los documentos del equipo: el área de equipo redirige, la bandeja sólo lista lo dirigido a la cuenta y las lecturas del equipo se rechazan (`document.find` / `envelope.get` por sesión y `GET /api/v2/envelope[/{id}]` → 403 con el mensaje de lectura, sin filtrar el título) | `sign-only-isolation.spec.ts`               |
| D2  | URL con ids manipulados (documento ajeno bajo el propio equipo, otro equipo, otra organización, propia organización, admin) → bandeja | `sign-only-isolation.spec.ts`               |
| D3  | Invitado como MEMBER intenta subir: sesión propia con `envelope.create` → 403 y sin control de subida | `sign-only-isolation.spec.ts`               |
| E1  | Un firmante CONTROLADO (regresión) sigue sin descarga: regla `canDownloadDocument` y ruta de descarga por token → 403. Cobertura amplia en `e2e/api/v2/controlled-signer-file-access.spec.ts` | `sign-only-downloads.spec.ts`               |
| E2  | Firmante con cuenta SIGN_ONLY no descarga en ninguna superficie: sesión (firmado y original) → 403, token de destinatario → 403, API v1 → 403, la política que consume la UI oculta ambas versiones (con sesión y con token), la página "Document Signed" no ofrece control de descarga y la regla de adjunto por destinatario devuelve `false` | `sign-only-downloads.spec.ts`               |
| E3  | Cuenta SIGN_ONLY con privilegios SGC (rol de equipo SGC verificado en BD) tampoco descarga: mismas rutas → 403 y política oculta | `sign-only-downloads.spec.ts`               |
| E4  | Ver no es descargar: la cuenta restringida abre el visor del documento que firma (`…/dataId/{id}/current/item.pdf` → 200 `application/pdf`) mientras la descarga sigue en 403 | `sign-only-downloads.spec.ts`               |
| E5  | El correo real de "documento completado" que recibe el firmante restringido llega **sin el documento**: se lee del servidor de correo de prueba (`inbucket`) que la firma hace llegar, y el mensaje identificado (asunto `Signing Complete!`, dirección de la cuenta entre sus destinatarios y entrada `EMAIL_SENT`/`DOCUMENT_COMPLETED` de esa dirección en el log de auditoría) no lleva el PDF, ni en sus partes MIME ni en su fuente SMTP | `sign-only-downloads.spec.ts`               |
| E5b | La transición de la que nace la regla: la cuenta se crea como `[USER]`, firma el documento con el perfil completo y se restringe a `SIGN_ONLY` **después del sellado y antes de que el job de completación envíe**. El envío queda detenido por un advisory lock por documento (determinista, sin lock global, sin estado transitorio) mientras el test confirma la restricción; el correo de completación, resuelto sobre el perfil ya restringido en el momento del envío, llega sin PDF; el buzón tiene también la invitación, así que la aserción es sobre el mensaje identificado y no sobre "cualquier mensaje sin PDF" | `sign-only-downloads.spec.ts`               |
| F1  | Promoción SIGN_ONLY→USER desde `/admin/users/{id}` efectiva en la siguiente petición: el token API previo deja de recibir 403 y la carpeta se crea; no se crea organización personal | `sign-only-profile-changes.spec.ts`         |
| F2  | Degradación USER→SIGN_ONLY con sesión y token previos: la sesión se invalida (redirige a `/signin`) y el token recibe 403 en su siguiente escritura, sin crear nada | `sign-only-profile-changes.spec.ts`         |
| F3  | USER promovido sin organización personal trabaja en el equipo asignado: inicia sesión, aterriza en `/t/{team}/documents`, el control de subida existe y su token crea una carpeta en ese equipo | `sign-only-profile-changes.spec.ts`         |
| G1  | Un administrador conserva sus funciones: aterriza en su equipo, sube un documento por la UI (queda en `PENDING`/editor), crea un equipo y entra al panel `/admin/users` | `sign-only-regressions.spec.ts`             |
| G2  | Un destinatario externo sin cuenta se rige por su rol: `canAttachDocumentPdfToAddressee` → `true` y descarga por token → 200 | `sign-only-downloads.spec.ts`               |
| G3  | Una cuenta `[USER]` existente conserva acceso completo: sesión válida, `/t/{team}/documents` con control de subida y su token crea una carpeta | `sign-only-regressions.spec.ts`             |

## Escenarios fuera de la suite y por qué

| Id | Motivo                                                                                                                                                                                                                                                                             |
| -- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A2 | Alta por SSO. Requiere un proveedor de identidad OIDC real; no hay harness que lo simule en `packages/app-tests`. La regla (toda alta entrega el perfil restringido) queda cubierta por A1/A3 y por los tests unitarios de `create-user` y `handle-oauth-organisation-callback-url`. Test marcado con `test.skip` en `sign-only-onboarding.spec.ts`, sin evidencia simulada. |

Queda un único escenario fuera de la suite (A2). Los que estaban documentados como pendientes ya
tienen test: la transición En espera → Pendientes (B) con un documento SEQUENTIAL cuyo segundo
firmante es la cuenta restringida, el correo real sin adjunto (E5) leído del servidor de correo de
prueba, y la transición `[USER]` → `SIGN_ONLY` entre el sellado y el envío (E5b).

## Cierres de los que dependen los specs (ya en develop)

Los dos cierres residuales están mergeados en `develop` y forman parte de la base de esta rama
(M31 en `b1a80c9`, M32 en `9d8a8c5`):

- **M31** (descarga residual): la descarga por token de destinatario resuelve la cuenta del
  destinatario y deniega con `ACCOUNT_DOWNLOAD_FORBIDDEN`; la página de firma y la de "Document
  Signed" ocultan el control de descarga para una cuenta restringida. De ahí las aserciones de E2
  por token, las dos llamadas a la política (con sesión y con token) y la ausencia de control en la
  página de documento firmado.
- **M32** (lecturas aisladas): las queries de ámbito equipo/organización se rechazan con 403
  (`RESTRICTED_ACCOUNT_READ_MESSAGE`) y la política de descarga de un visor por token también
  resuelve la cuenta del destinatario. De ahí las aserciones de lectura de D1 (`document.find`,
  `envelope.get`, `GET /api/v2/envelope[/{id}]`), que exigen el mensaje de lectura además del
  código `FORBIDDEN`; en la superficie de sesión el cuerpo lleva el error aunque el HTTP sea 200 en
  una llamada batcheada, y los helpers lo aceptan.

Y el cierre del que depende F2, también en `develop`:

- **M33** (perfil persistido): `admin.user.update` persiste la combinación solicitada y no vuelve a
  escribir `[USER]` al asignar `SIGN_ONLY`. Sin eso F2 veía `[USER]` donde el perfil restringido
  espera `[SIGN_ONLY]`; con ello la cuenta queda restringida de verdad, la misma ruta invalida sus
  sesiones previas y su token anterior recibe 403 en la siguiente escritura.

## Adjunto del correo: cómo se comprueba

La mitad "ni adjunto" de E2 se afirma en dos niveles:

- La **regla de envío** (`canAttachDocumentPdfToAddressee`, la función que consultan los envíos)
  devuelve `false` para la cuenta restringida (`sign-only-downloads.spec.ts`, E2).
- El **mensaje real**: E5 firma con la cuenta restringida y lee su buzón en `inbucket`; ninguna
  parte del mensaje ni su fuente SMTP (`…/source`) es un PDF. El envío sale de un job
  (`send.document.completed.emails`) y el test espera la entrada `EMAIL_SENT` /
  `DOCUMENT_COMPLETED` del log de auditoría para esa dirección antes de leer el buzón, de forma que
  lo que se inspecciona es el correo de cierre y no otro anterior.
- **Qué mensaje se inspecciona**: el buzón guarda también la invitación a firmar, así que las dos
  aserciones seleccionan el mensaje como el correo de completación — asunto `Signing Complete!` (el
  msgstr inglés de `Signing Complete!` que sirve el catálogo) y la dirección de la cuenta entre sus
  destinatarios — y exigen la entrada de auditoría `EMAIL_SENT` / `DOCUMENT_COMPLETED` de esa misma
  dirección. "Un mensaje cualquiera sin PDF" no sería evidencia: la invitación tampoco adjunta el
  documento.
- **Cuándo se decide**: E5b firma con una cuenta `[USER]` completa y mantiene el job de envío detenido
  con un advisory lock por documento hasta que la restricción está confirmada, así que el envío
  resuelve la política sobre el perfil restringido y no sobre el que tenía al completarse el
  documento. El mecanismo está en "La ventana de E5b".

`inbucket` es el servidor de correo del compose de desarrollo (`docker/development/compose.yml`,
HTTP en el puerto 9000, SMTP en el 2500), que `npm run dx:up` levanta y que
`e2e/emails-branding.spec.ts` y `e2e/documents/resend-signed-document.spec.ts` ya usan. E5 y E5b
necesitan ese contenedor en marcha, como el resto de la suite de correo.

### La ventana de E5b (sellado → restricción → envío)

El sellado (`internal.seal-document`) y el envío (`send.document.completed.emails`) son jobs: el
primero confirma el sellado y después encola el segundo. E5b necesita las dos cosas a la vez: que el
job de envío exista **antes** de restringir la cuenta (para acreditar que se encoló con el perfil
completo) y que el envío **no resuelva nada** hasta que la restricción esté confirmada. Eso lo da una
pausa determinista, no una carrera ganada por tiempo:

1. **Antes de completar la firma**, el test toma un lock de *sesión* (`pg_advisory_lock`) sobre una
   clave derivada del `envelopeId` (`hashtext(<envelopeId>)::bigint`), en un cliente Prisma propio
   limitado a una conexión (`connection_limit=1`): un lock de sesión pertenece a la conexión que lo
   toma y el cliente compartido está en pool, así que liberarlo desde otra conexión lo dejaría colgado
   en el pool el resto de la corrida. El `try`/`finally` y el cierre del cliente son la red de
   seguridad si el test falla con la pausa tomada.
2. La firma se completa con la cuenta todavía `[USER]` y el test espera `Envelope.status ===
   COMPLETED`.
3. El sellado encola el job de envío (fila en `BackgroundJob`) con la cuenta aún `[USER]`: el `INSERT`
   no está bloqueado por el lock del test. El test espera esa fila y, si no aparece, falla ahí (no
   sigue a ciegas).
4. El handler del job espera ese mismo lock al empezar (hook test-only, ver abajo). Mientras el test
   lo tiene, el handler está detenido: `pg_locks` lo reporta como waiter de esa clave y el test lo
   comprueba antes de restringir. Esa comprobación es la que acredita que la pausa está en efecto; sin
   ella, un entorno sin la variable de la pausa podría pasar por un camino distinto al que el
   escenario quiere probar.
5. Con el job detenido, el test escribe `roles: [SIGN_ONLY]` vía Prisma y **relee** la cuenta para
   confirmar la restricción, ya confirmada e invisible para el job.
6. El test libera el lock. El handler continúa con lo que sigue del job y resuelve la política de
   adjunto en el momento del envío, sobre el perfil ya restringido. Después el test espera la entrada
   `EMAIL_SENT`/`DOCUMENT_COMPLETED` y lee el buzón.

El test no se fía de su propio orden: lo lee de la base de datos. Además de la pausa en sí, comprueba
que `Envelope.completedAt` es anterior a la restricción, que las filas del job de envío son anteriores
a la restricción (estaban encoladas con la cuenta `[USER]`) y que las entradas de auditoría del envío
son posteriores.

**Por qué un advisory lock**: es determinista (la pausa es un estado que se mantiene hasta que el test
lo libera, no una ventana de tiempo que hay que ganar), es **por documento** (la clave sale del
`envelopeId`, así que ningún otro job ni otro test queda bloqueado) y no toca el esquema. El diseño
anterior tomaba `LOCK TABLE "BackgroundJob" IN SHARE MODE` y esperaba a ver el job de sellado en
`PROCESSING`: bloqueaba la tabla de jobs entera -todos los envíos del proceso- y dependía de alcanzar
un estado transitorio, además de perder la carrera contra un sellado que terminara antes de que el
test llegara a mirar.

El mecanismo son dos partes que tienen que cambiar juntas:

- **App**: `packages/lib/jobs/definitions/emails/e2e-completion-email-pause.ts`, llamado al inicio de
  `send-document-completed-emails.handler.ts`. Sólo actúa si `E2E_PAUSE_COMPLETION_EMAIL === 'true'`
  (un test unitario fija que sin la variable no toca la base). Espera dentro de una transacción
  interactiva con `pg_advisory_xact_lock(...)` y timeout de 120 s: Prisma fija la transacción a una
  conexión y Postgres suelta su lock cuando la transacción termina -commit, rollback o timeout-, así
  que no puede quedar pegado en una conexión del pool ni siquiera si el handler lanza.
- **Test**: `e2e/sign-only/sign-only-downloads.spec.ts`, E5b y el helper `holdCompletionEmailPause`,
  que usa la misma expresión -`hashtext(<envelopeId>)::bigint`- que el módulo de la app.

**La variable se activa sólo en el arranque de la suite e2e**: los scripts `test:e2e` y
`test:e2e:shard` de `packages/app-tests/package.json` exportan `E2E_PAUSE_COMPLETION_EMAIL=true` antes
de `start-server-and-test`, así que la app que arrancan la tiene y ningún otro entorno (dev,
producción) la ve. En modo dev contra un servidor ya levantado hay que dársela a la app, p. ej.
`E2E_PAUSE_COMPLETION_EMAIL=true npm run dev` o en `.env.local`; E5b falla con un mensaje explícito si
el job nunca se detiene.

## Cómo ejecutar

Requisitos: Postgres accesible, `DATABASE_URL` en `.env`, migraciones aplicadas, `inbucket` en
marcha (lo levanta `npm run dx:up`; sólo lo necesitan los escenarios que leen correo, E5 y E5b) y
la app levantada (o usar `npm run test:e2e`, que arranca el servidor). Los paths de Playwright se
resuelven desde `packages/app-tests`.

```bash
# Todo el bloque SIGN_ONLY (proyecto ui)
npm run test:e2e -- --project=ui e2e/sign-only

# Un escenario concreto
E2E_TEST_PATH=e2e/sign-only/sign-only-onboarding.spec.ts npm run test:e2e

# En modo dev contra un servidor ya levantado. E5b necesita que esa app tenga la variable de la
# pausa (la exportan los scripts `test:e2e`, aquí hay que dársela al servidor):
E2E_PAUSE_COMPLETION_EMAIL=true npm run dev
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
- Las aserciones de la UI van por rol y `testid`, no por el texto fuente: la cabecera de la
  invitación se escribe "Organisation invitation" en el código y el catálogo inglés la sirve como
  "Organization invitation", así que A3 la afirma por rol y acepta las dos grafías.
- Las mutaciones tRPC sin endpoint público (`team.create`, `organisation.create`,
  `admin.user.update`, `envelope.create`) se llaman por `POST /api/trpc/<ruta>` con la sesión de la
  página, en el formato superjson no batcheado que usan los helpers de consulta existentes. El
  cuerpo lleva el schema completo: `team.create` exige `inheritMembers` (no tiene default), así que
  G1 lo envía explícitamente; sin él la mutación ni siquiera llega al handler.
- Firmar un documento de envelope v2 no es sólo rellenar el pad: los campos se dibujan en el canvas
  de Konva, así que el pad del formulario fija la firma y el campo se inserta **haciendo clic sobre
  el campo en el canvas** (el mismo paso que usa
  `e2e/envelopes/envelope-v2-field-insertion.spec.ts`). A4, B y E5/E5b usan para eso
  `signEnvelopeSignatureField` de `e2e/fixtures/signature.ts`, que espera además a que el campo
  quede `inserted` en la base de datos; sin el clic el formulario sigue diciendo "1 Field Remaining"
  y el botón de cierre se llama "Next Field", no "Complete".
- A4 y E5b siembran el documento por la API (`apiSeedPendingDocument`), que crea el envelope como lo
  hace el producto y añade un campo de firma por firmante. El `seedPendingDocument` de
  `@documenso/prisma/seed/documents` sólo crea un campo `NAME` ya insertado: con él no hay pad de
  firma que abrir ni campo que firmar.
- E5b restringe la cuenta con una escritura de Prisma entre dos verificaciones -el `Envelope` sellado y
  la fila del job de envío- y libera la pausa después de releer la restricción; no usa la ruta de
  administración porque el escenario es sobre el momento del envío y no sobre el cambio de perfil (esa
  ruta está cubierta por F1/F2).
