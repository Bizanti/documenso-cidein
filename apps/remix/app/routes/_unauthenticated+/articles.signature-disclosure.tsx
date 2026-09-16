import { SUPPORT_EMAIL } from '@documenso/lib/constants/app';
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
