// Guía "Cómo se usa": flujo completo y detalle de cada paso, para quien
// use el panel por primera vez. Se abre en la sección del paso en que se está.

import { $, prefs } from "./comun.js";

const SECCIONES = [
  {
    id: "flujo", titulo: "El flujo en 6 pasos", html: `
    <p>El panel arma los archivos de carga masiva de pago a proveedores de BancoEstado (formato DET-SUBDET, 9 columnas), con <b>una nómina por fuente de financiamiento</b>. Todo queda guardado en Firebase y el equipo lo ve al instante.</p>
    <ol class="guia-pasos">
      <li><b>Proveedores.</b> Verifica que el proveedor esté en el maestro con sus datos bancarios. Si no está, agrégalo.</li>
      <li><b>Documentos a pagar.</b> Carga las facturas o boletas y deja <b>marcadas</b> las que se pagan ahora.</li>
      <li><b>Revisar y generar.</b> Corrige los errores y genera la nómina de cada fuente. Se descargan el <b>.txt</b> y el <b>Excel BancoEstado</b>.</li>
      <li><b>Subir al banco.</b> Sube el .txt en el portal de BancoEstado. Luego, en la Bitácora, pulsa <b>Marcar como cargada</b> con la fecha de carga y la fecha de pago.</li>
      <li><b>Resultado.</b> Desde las 14:00 del día de pago, registra el resultado: <b>Pagado</b> o <b>Rechazado</b> con su motivo.</li>
      <li><b>Rechazos.</b> Corrige los datos bancarios del proveedor y pulsa <b>Volver a pendientes</b>: sus documentos se pagan en otra nómina.</li>
    </ol>
    <p>Para <b>remuneraciones, viáticos, fondos fijos u honorarios</b> de personas naturales, usa la pestaña <b>Remuneraciones</b>: reemplaza los pasos 1 a 3 con la planilla de 7 columnas, y luego sigue igual en la Bitácora.</p>`
  },
  {
    id: "p1", titulo: "1. Proveedores", html: `
    <ul>
      <li><b>Agregar uno:</b> completa el formulario y pulsa <b>Guardar proveedor</b>. <b>Usar Cuenta RUT</b> llena la cuenta con el RUT sin dígito verificador (BancoEstado).</li>
      <li><b>Carga masiva:</b> pega filas copiadas desde Excel en el orden RUT ⇥ Nombre ⇥ Email ⇥ Código banco ⇥ Forma de pago ⇥ N° cuenta ⇥ Sector, o usa <b>Importar archivo</b> (.xls, .xlsx, .csv). También acepta una <b>planilla de pago anterior del banco</b>: toma los proveedores y sus documentos.</li>
      <li><b>Editar:</b> toca la fila del proveedor. Los cambios de banco, cuenta o forma de pago quedan en el <b>historial del proveedor</b> con el antes y el después.</li>
      <li>La razón social se limpia sola: mayúsculas, sin tildes ni ñ, máximo 60 caracteres. El panel revisa el dígito verificador del RUT, que la forma 02 sea solo con BancoEstado y que la cuenta tenga solo dígitos.</li>
      <li>Cambiar el RUT o eliminar un proveedor lo pueden hacer solo los administradores.</li>
    </ul>`
  },
  {
    id: "p2", titulo: "2. Documentos a pagar", html: `
    <ul>
      <li><b>Fuentes de financiamiento:</b> cada fuente (GENERAL, SEP, PIE, FAEP…) genera su propia nómina. Puedes agregar fuentes nuevas.</li>
      <li><b>Pegar documentos:</b> RUT ⇥ Fecha ⇥ Monto ⇥ N° doc ⇥ Tipo doc ⇥ Fuente ⇥ DC. La fuente y el DC son opcionales; las filas sin fuente van a la que elijas en “Filas sin fuente van a”.</li>
      <li><b>Detalle de Nómina del banco:</b> el Excel que descargas de BancoEstado en <i>Mis Nóminas → Ver Nómina → Ver Documento</i> también se sube con <b>Importar archivo</b>. Toma cada documento con su N°, fecha, monto y tipo (el banco lo escribe en texto, por ejemplo “FACTURA ELECTRONICA”, y el panel lo pasa a su código, 33). La fuente sale del nombre de la nómina (por ejemplo <code>PAGO_PROVEEDORES_FAEP</code> → FAEP). Si un documento ya está pendiente no se duplica, y si había quedado sin tipo, se completa. Ese archivo no trae el N° de cuenta: si el proveedor no está en el maestro, se agrega para que completes su cuenta.</li>
      <li><b>Plantilla Excel:</b> <b>Descargar plantilla para completar</b> trae listas desplegables de tipo de documento y de fuentes. Complétala y súbela con <b>Importar archivo</b>. Si el nombre del archivo incluye la fuente (por ejemplo <code>documentos_SEP.xlsx</code>), los documentos van a esa fuente.</li>
      <li><b>Marcar para pagar:</b> solo los documentos marcados entran en la nómina. Los desmarcados quedan guardados para otro día.</li>
      <li>En la barra de la tabla puedes <b>filtrar por fuente</b>, <b>mover</b> los marcados a otra fuente o <b>quitarlos</b>.</li>
      <li><b>Editar:</b> el botón <b>Editar</b> de cada documento lo carga en “Agregar un documento” para corregir el RUT, la fecha, el monto, el N°, el tipo, la fuente o el DC. Pulsa <b>Guardar cambios</b>; el cambio queda en el historial con el antes y el después.</li>
      <li>Las notas de crédito (tipos 60 y 61) se <b>restan</b> del total del proveedor.</li>
      <li>Un documento sin monto válido no se agrega; el aviso dice cuáles quedaron fuera.</li>
    </ul>`
  },
  {
    id: "p3", titulo: "3. Revisar y generar", html: `
    <ul>
      <li>La tabla muestra una fila por fuente con sus documentos marcados y el estado: <span class="tag okk">lista</span> o <span class="tag err">N errores</span>. Toca una fuente para revisarla.</li>
      <li>Los <b>errores</b> bloquean solo esa fuente; los <b>avisos</b>, como una nota de crédito descontada, no bloquean.</li>
      <li>Revisa el archivo con <b>Planilla BancoEstado</b> o <b>Texto .txt</b>. <b>Excel borrador</b> sirve para revisión o visto bueno y no registra nada.</li>
      <li><b>Generar nómina N° X y registrar</b> reserva el número correlativo, saca los documentos de pendientes y descarga el <b>.txt</b> y el <b>Excel BancoEstado</b>. Se abre además una ventana con un botón para cada archivo, por si el navegador bloqueó la segunda descarga. Si otra persona movió alguno de esos documentos mientras revisabas, no se genera y te avisa.</li>
      <li>El archivo se llama <code>prefijo_FUENTE</code>, por ejemplo <code>20260926_PAGO_PROVEEDORES_SEP.txt</code>. La fuente se agrega sola.</li>
      <li>Si dos personas generan a la vez, cada una recibe un número distinto.</li>
    </ul>`
  },
  {
    id: "p6", titulo: "Remuneraciones y abonos", html: `
    <p>Para pagos a <b>personas naturales</b> que no llevan documentos: viáticos, fondos fijos y cajas chicas, honorarios y remuneraciones. Usa la planilla BancoEstado <b>“Pago Solo Abonos DET” de 7 columnas</b>: RUT, nombre, email, banco, forma de pago, N° de cuenta y monto. Se hace una nómina por fuente de financiamiento.</p>
    <ul>
      <li><b>Cargar:</b> importa la planilla del banco ya completa (hoja DETALLE), o pega filas copiadas desde Excel. Elige el <b>concepto</b> de la carga. Si el nombre del archivo lo dice, se deduce solo (por ejemplo, “REPOSICION FONDOS FIJOS” queda como Fondos fijos) y también la fuente (<code>…_SEP.xlsx</code>).</li>
      <li><b>Detalle de Nómina del banco:</b> también puedes subir el Excel de <i>Mis Nóminas → Remuneraciones → Ver Nómina</i>. El banco y la forma de pago vienen en texto y el panel los pasa a sus códigos (BANCOESTADO → 012; CuentaRUT → 30; cuenta corriente o vista → 01; Pago Cash → 29). El concepto y la fuente salen del nombre de la nómina (por ejemplo <code>FONDO_FIJO_EE_GENERAL</code> → Fondos fijos, GENERAL). Si un abono ya estaba pendiente no se duplica, y si había quedado con banco o forma “?”, se corrige.</li>
      <li>Los nombres se pasan solos a <b>mayúsculas sin tildes ni ñ</b>, como exige el banco. En las formas de pago sin cuenta (vale vista o pago cash: 20, 23, 28 y 29) el N° de cuenta va <b>en blanco</b>. En CuentaRUT (30), la cuenta es el RUT sin dígito verificador.</li>
      <li><b>Agregar uno a mano:</b> al escribir el RUT se completan los datos del último pago a esa persona.</li>
      <li><b>Editar:</b> en la lista de abonos por pagar, <b>Editar</b> carga el abono en el formulario. Corrige y pulsa <b>Guardar cambios</b>. Si cambian el banco, la forma de pago o la cuenta, queda en el historial con el antes y el después.</li>
      <li><b>Controles:</b> el panel avisa si los datos bancarios de una persona <b>cambiaron</b> respecto de su último pago, si un RUT y monto se repiten en la nómina, y si ya hay un pago igual en otra nómina que aún no tiene resultado.</li>
      <li><b>Generar:</b> usa el mismo número correlativo que proveedores y descarga el .txt y el Excel de 7 columnas. El archivo se llama <code>AAAAMMDD_CONCEPTO_FUENTE</code>, por ejemplo <code>20260917_FONDOS_FIJOS_SEP.txt</code>.</li>
      <li>Después sigue igual que proveedores en la <b>Bitácora</b>: marcar como cargada, fecha de pago, resultado, rechazos y volver a pendientes. Los abonos rechazados vuelven a esta pestaña.</li>
    </ul>`
  },
  {
    id: "p4", titulo: "4. Bitácora de nóminas", html: `
    <ul>
      <li>Los <b>contadores</b> de arriba filtran la tabla: generadas sin cargar, esperando resultado, por registrar resultado, con rechazos por reintegrar, <b>por cobrar en banco</b> y <b>pagadas</b>, con el monto de cada grupo. Con un contador activo, la tabla muestra solo ese grupo: una nómina que cambia de estado pasa a otro contador. Toca el mismo contador otra vez, o <b>Ver todas</b>, para volver a la lista completa.</li>
      <li>El <b>buscador</b> encuentra una factura por N° de documento, RUT, proveedor o DC, y muestra en qué nóminas estuvo. También encuentra una nómina por su N° BancoEstado.</li>
      <li>Toca una nómina para ver su detalle e historial. Tócala de nuevo, o pulsa <b>Cerrar</b>, para cerrarlo.</li>
      <li><b>Marcar como cargada:</b> indica la <b>fecha de carga</b>, la <b>fecha de pago</b> (se sugiere el día hábil siguiente), el <b>N° de nómina BancoEstado</b> (el número que da el banco al cargarla; es obligatorio y se ve en la tabla) y una observación. Queda registrado quién la cargó.</li>
      <li><b>Resultado:</b> desde las 14:00 del día de pago, marca cada pago como <b>Pagado</b> o <b>Rechazado</b> con su motivo. <b>Marcar pendientes como pagados</b> aplica “Pagado” al resto de una vez.</li>
      <li><b>Cargar reporte del banco:</b> en BancoEstado, abre la nómina y descarga el <b>Detalle de Nómina</b> en Excel; después suéltalo aquí (puedes soltar varios a la vez, de proveedores y de remuneraciones). Cada archivo se dirige a su nómina por el <b>N° BancoEstado</b> y aparece una <b>vista previa</b> con lo que quedaría registrado: <i>Pagado</i>, <i>Rechazado</i> con el motivo que da el banco, y los pagos cash como <i>pagados y por cobrar en banco</i>. Hasta que pulses <b>Registrar</b> no se escribe nada. Lo que no calza no se toca y se avisa: un archivo de otra nómina, un monto distinto al de la nómina, un estado que el panel no conoce, o un pago que ya se reintegró. Subir el mismo archivo dos veces no cambia nada la segunda vez, y cada resultado registrado así queda en el historial con el nombre del archivo.</li>
      <li><b>Cobro en banco</b> (remuneraciones pagadas con pago cash o vale vista, como los fondos fijos): aunque el banco pague la nómina, el dinero queda <b>Pendiente de cobro</b> hasta que la persona lo retira. En el detalle, marca <b>Cobrado</b> con su fecha cuando se retire, o <b>No cobrado (devuelto)</b> si los fondos volvieron a la cuenta; en ese caso “Volver a pendientes” deja el abono en Remuneraciones para pagarlo de nuevo. Mientras falte retirar, la nómina queda en <b>Por cobrar en banco</b>.</li>
      <li><b>Volver a pendientes:</b> en un pago rechazado, devuelve sus documentos al paso 2 con la marca “Rechazado en nómina N° X”.</li>
      <li><b>Anular nómina:</b> solo si todavía no se cargó en el banco. Sus documentos vuelven a pendientes y la nómina queda cerrada.</li>
      <li><b>Deshacer carga:</b> vuelve a “generada” si ningún pago tiene resultado.</li>
      <li><b>Registrar transferencia:</b> para los pagos directos por transferencia electrónica (sin nómina), como un servicio básico o un sueldo rechazado. Sube el <b>Comprobante</b> o el <b>Detalle de Transferencia Electrónica</b> en PDF tal como lo descargas de BancoEstado (puedes elegir o soltar varios): el panel lee el N° de transferencia, el ID TEF, la fecha y hora, la cuenta de origen, el beneficiario, el monto, el concepto, el mensaje y quiénes la prepararon y autorizaron. Si el monto calza con <b>documentos pendientes</b> del paso 2 o con un <b>abono</b> de Remuneraciones del mismo RUT, los deja marcados; si no, queda como <b>sin documento</b>. Revisa el resumen y pulsa <b>Registrar</b>; con <b>Corregir datos</b> cambias lo que haga falta. La lectura se hace en el mismo navegador: el PDF no se sube a ninguna parte. También se puede <b>ingresar a mano</b>. Queda en la bitácora como <b>pagada</b>, con el mismo correlativo de las nóminas y el N° de transferencia en la columna N° BancoEstado. Si se registró mal, <b>Anular transferencia</b> devuelve lo que pagaba a pendientes.</li>
      <li>Las <b>cuentas de origen</b> se asocian a su fuente en Configuración: al registrar una transferencia, la fuente se completa sola.</li>
      <li>Puedes descargar otra vez el .txt o el Excel de cualquier nómina, y exportar la bitácora a CSV.</li>
      <li><b>Reporte de pagos:</b> al final de la Bitácora. Elige el período (por fecha de pago de la nómina), el tipo y la fuente. Muestra lo pagado, lo rechazado y lo pendiente de resultado, y lo descarga en <b>Excel</b> o en <b>PDF</b> (listo para imprimir o enviar): resumen por fuente, nóminas del período, detalle de lo pagado por documento o abono, y rechazos.</li>
      <li><b>Pagos a un proveedor:</b> en el reporte de pagos, escribe en <b>Proveedor o beneficiario</b> su RUT o parte del nombre (sugiere los del maestro). El reporte queda solo con sus pagos: totales, la lista de cada pago (fecha, nómina, N° BancoEstado, documentos, monto y resultado; al tocar uno se abre su nómina) y el Excel o PDF. Usa <b>Todo</b> para ver todas las fechas. También desde la ficha del proveedor, con <b>Ver pagos a este proveedor</b>.</li>
      <li><b>Reporte de pago de una nómina:</b> en el detalle de una nómina o transferencia cargada, <b>Reporte de pago (Excel)</b> y <b>Reporte de pago (PDF)</b> descargan el respaldo de lo pagado en esa nómina, con un formato propio del panel (no el del banco): sus datos (N° del panel y de BancoEstado, fuente, estado, archivo, quién la generó y cargó, fecha de pago), los totales pagado, rechazado y pendiente, el detalle de lo pagado por documento o abono, los rechazos con su motivo y el historial.</li>
    </ul>`
  },
  {
    id: "p5", titulo: "Configuración", html: `
    <ul>
      <li><b>Prefijo del archivo:</b> <code>AAAAMMDD</code> se reemplaza por la fecha del día.</li>
      <li><b>Email por defecto:</b> se usa cuando el proveedor no tiene correo.</li>
      <li><b>Feriados:</b> el panel los salta al sugerir la fecha de pago y al calcular desde cuándo está el resultado del banco.</li>
      <li><b>Respaldo:</b> descarga todo el panel en un .json, que contiene datos bancarios. Los administradores pueden además importar un respaldo.</li>
      <li>Arriba a la derecha eliges el tema: claro, oscuro o igual al sistema.</li>
    </ul>`
  },
  {
    id: "faq", titulo: "Preguntas frecuentes", html: `
    <dl class="guia-faq">
      <dt>“El RUT no está en el maestro de proveedores”</dt><dd>Pulsa <b>Agregar</b> en esa fila del paso 2, o agrega el proveedor en el paso 1 con sus datos bancarios.</dd>
      <dt>“Este documento ya está en la nómina N° X”</dt><dd>Ese documento ya se envió al banco. Quítalo de pendientes o, si esa nómina no se cargó, anúlala.</dd>
      <dt>El total de un proveedor queda en cero o negativo</dt><dd>Hay una nota de crédito mayor que sus facturas. Revisa los documentos marcados de ese proveedor.</dd>
      <dt>No veo un cambio que hizo otra persona</dt><dd>Los cambios llegan solos en segundos. Si no aparecen, recarga la página.</dd>
      <dt>“Falta publicar las reglas nuevas” en Remuneraciones</dt><dd>Firestore todavía no tiene las reglas de la colección de abonos. Un administrador debe pegar el archivo de reglas actualizado en Firebase.</dd>
      <dt>¿Quién puede entrar?</dt><dd>Solo los correos de la lista de acceso del equipo de Finanzas. Para sumar a alguien, pídeselo a un administrador.</dd>
    </dl>`
  },
];

export function init() {
  const dlg = $("guia");
  $("guiaIndice").innerHTML = SECCIONES.map(s => `<a href="#guia-${s.id}" data-sec="${s.id}">${s.titulo}</a>`).join("");
  $("guiaCuerpo").innerHTML = SECCIONES.map(s => `<section id="guia-${s.id}"><h3>${s.titulo}</h3>${s.html}</section>`).join("");
  $("guiaIndice").addEventListener("click", e => {
    const a = e.target.closest("a[data-sec]"); if (!a) return;
    e.preventDefault(); ir(a.dataset.sec);
  });
  $("btnGuia").onclick = () => {
    dlg.showModal();
    // Abre en el paso en que se está; el flujo general queda al principio.
    ir(["1", "2", "3", "4", "5", "6"].includes(prefs.step) ? "p" + prefs.step : "flujo", false);
  };
  $("guiaCerrar").onclick = () => dlg.close();
  dlg.addEventListener("click", e => { if (e.target === dlg) dlg.close() }); // clic fuera de la guía
}

function ir(id, suave = true) {
  const sec = $("guia-" + id); if (!sec) return;
  $("guiaCuerpo").scrollTo({ top: sec.offsetTop - $("guiaCuerpo").offsetTop, behavior: suave ? "smooth" : "auto" });
  $("guiaIndice").querySelectorAll("a").forEach(a => a.setAttribute("aria-current", String(a.dataset.sec === id)));
}
