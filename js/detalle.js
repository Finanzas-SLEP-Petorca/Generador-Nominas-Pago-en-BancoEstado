// Detalle de Nómina en el formato que BancoEstado deja descargar cuando
// termina de procesar una nómina (desde las 14:00 del día de pago). Hay otro
// sistema que solo acepta ese archivo, así que se reproduce igual: mismas
// partes del libro (estilos, tema y propiedades fijas en
// assets/plantilla_detalle_nomina.xlsx), mismas celdas, tipos, textos
// compartidos y anchos de columna (el texto más largo + 2).
//   · Proveedores: "Mis Nóminas - Ver Nómina - Ver Documentos", una fila por documento.
//   · Remuneraciones: "Mis Nóminas - Remuneraciones - Ver Nómina", una fila por pago.
// Funciones puras (sin DOM ni Firestore), probadas en tests/formato.test.mjs.

import { M_TIPO, FORMAS_SIN_CUENTA } from "./catalogos.js";
import { S, fmtRut, cleanName, tipoDe, esCobroCaja } from "./formato.js";

// Nombre de cada banco como lo escribe BancoEstado en el detalle (los vistos
// en archivos reales; el resto, el nombre oficial del banco).
const NOMBRE_BANCO = {
  "012": "BANCOESTADO", "001": "BANCO DE CHILE", "016": "BANCO DE CREDITO E INVERSIONES", "037": "BANCO SANTANDER-CHILE", "028": "BANCO BICE",
  "039": "BANCO ITAU CHILE", "014": "SCOTIABANK CHILE", "049": "BANCO SECURITY", "051": "BANCO FALABELLA", "053": "BANCO RIPLEY",
  "055": "BANCO CONSORCIO", "009": "BANCO INTERNACIONAL", "031": "HSBC BANK (CHILE)", "041": "JP MORGAN CHASE BANK, N. A.", "672": "COOPEUCH"
};
export const bancoDetalle = (codigo, catalogo = {}) => NOMBRE_BANCO[codigo] || S(catalogo[codigo]).split(" / ")[0] || S(codigo);

// Forma de pago como la escribe el banco.
export function formaDetalle(forma) {
  if (forma === "30") return "Abono en CuentaRUT";
  if (forma === "02") return "Abono en Cuenta de Ahorro";
  if (forma === "22") return "Abono en Chequera Electrónica / Cuenta Vista";
  if (forma === "29") return "Pago Cash";
  if (FORMAS_SIN_CUENTA.has(forma)) return "Vale Vista";
  return "Abono en Cuenta Corriente / Cuenta Vista";
}

// Tipo de documento como lo escribe el banco ("FACTURA ELECTRONICA").
const TIPO_BANCO = { "34": "FACTURA NO AFECTA O EXENTA ELECTRONICA" };
export const tipoDocDetalle = t => TIPO_BANCO[t] || cleanName(M_TIPO[t] || t);

// Concepto del pago en el banco: lo define el convenio y el tipo de carga.
const ANTICIPOS = /FONDO|CAJA CHICA|VIATICO/;
export const conceptoDetalle = n => tipoDe(n) === "abonos" ? (ANTICIPOS.test(cleanName(n.concepto)) ? "Anticipos" : "Remuneraciones / Pensiones") : "Proveedores";

const miles = v => Math.round(v).toLocaleString("es-CL").replace(/,/g, ".");
const pesos = v => "$ " + miles(v), pesosTotal = v => "$" + miles(v);
const ddmmaaaa = iso => { const [a, m, d] = S(iso).slice(0, 10).split("-"); return a ? `${d}/${m}/${a}` : "" };
const fechaDoc = f => /^\d{8}$/.test(S(f)) ? `${f.slice(0, 2)}/${f.slice(2, 4)}/${f.slice(4)}` : S(f);
const MOTIVO_PAGADO = " ".repeat(20); // el banco deja 20 espacios en el motivo de lo pagado

// Estado del pago como lo informa el banco al terminar el proceso. Un pago cash
// o vale vista pagado queda "Pendiente de Cobro" hasta que se retira.
function estadoBanco(n, p) {
  if (p.estado === "rechazado") return "Rechazado";
  if (esCobroCaja(n, p) && p.cobro !== "cobrado") return "Pendiente de Cobro";
  return "Pagado";
}
const motivoBanco = p => p.estado === "rechazado" ? S(p.motivo) : MOTIVO_PAGADO;

// ¿Se puede emitir? Solo nóminas de proveedores o remuneraciones cargadas y con
// el resultado de todos sus pagos (pagados o rechazados).
export function puedeDetalle(n) {
  if (!n || tipoDe(n) === "transferencia") return { ok: false, motivo: "Las transferencias no tienen Detalle de Nómina" };
  if (n.estado !== "cargada") return { ok: false, motivo: "La nómina no está cargada en BancoEstado" };
  const pend = n.pagos.filter(p => p.estado === "pendiente").length;
  if (pend) return { ok: false, motivo: `Falta el resultado de ${pend} pago${pend > 1 ? "s" : ""}` };
  return { ok: true };
}

// Fecha del encabezado, como la escribe el banco: "Oct 13, 2026, 11:12:05 AM".
const MESES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function fechaEncabezado(d) {
  const h = d.getHours(), dd = v => String(v).padStart(2, "0");
  return `${MESES[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}, ${h % 12 || 12}:${dd(d.getMinutes())}:${dd(d.getSeconds())} ${h < 12 ? "AM" : "PM"}`;
}

// Filas del detalle: cada celda es texto, número o null (celda vacía con estilo).
// meta: { convenio, nombreBanco, ahora: Date }.
export function filasDetalle(n, { convenio = "", nombreBanco = "", ahora = new Date() } = {}, catalogoBancos = {}) {
  const abonos = tipoDe(n) === "abonos";
  const filas = [];
  if (abonos) {
    filas.push(["Rut", "Nombre", "Fecha Abono", "Forma Abono", "Banco", "Código Propio", "N° Cuenta", "Estado Abono", "Motivo", "Monto Abono"]);
    // En esta vista el nombre sale tal como se subió (sin los dos espacios de Ver Documentos).
    n.pagos.forEach(p => filas.push([fmtRut(p.rut), S(p.nombre), ddmmaaaa(n.fechaPago || n.fechaCarga), formaDetalle(p.forma), bancoDetalle(p.banco, catalogoBancos), "",
      FORMAS_SIN_CUENTA.has(p.forma) ? "" : S(p.cuenta), estadoBanco(n, p), motivoBanco(p), pesos(p.monto)]));
  } else {
    filas.push(["Rut", "Nombre", "Centro Negocio", "Tipo Abono", "Banco", "Monto Total $", "Estado", "Motivo", "N° Documento", "Tipo Documento", "Fecha Emisión", "Monto $"]);
    n.pagos.forEach(p => p.docs.forEach(d => filas.push([fmtRut(p.rut), S(p.nombre) + "  ", "", formaDetalle(p.forma), bancoDetalle(p.banco, catalogoBancos), pesos(p.monto), estadoBanco(n, p), motivoBanco(p),
      /^\d{1,15}$/.test(S(d.ndoc)) ? Number(d.ndoc) : S(d.ndoc), tipoDocDetalle(d.tipo), fechaDoc(d.fecha), pesos(d.monto)])));
  }
  const datos = filas.slice(1);
  const estadoCol = abonos ? 7 : 6;
  const estadoNomina = datos.every(f => f[estadoCol] === "Pagado") ? "Aceptada" : "Aceptada Parcial";
  return {
    titulo: abonos ? "Mis Nóminas - Remuneraciones - Ver Nómina" : "Mis Nóminas - Ver Nómina - Ver Documentos",
    fecha: "Fecha : " + fechaEncabezado(ahora),
    cabecera: [
      ["Convenio", S(convenio) + "\t", "Nº Nómina", /^\d+$/.test(S(n.operacion)) ? Number(n.operacion) : S(n.operacion)],
      ["Nombre Nómina", S(nombreBanco), "Monto Total $", pesosTotal(n.total)],
      ["Cantidad Pagos", String(n.pagos.length), "Fecha Pago", ddmmaaaa(n.fechaPago || n.fechaCarga)],
      ["Concepto Pago", conceptoDetalle(n), "Estado Nómina Pagos", estadoNomina],
    ],
    filas, estadoNomina
  };
}

// ---------- XML de las partes que cambian ----------
const xmlEsc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const col = i => String.fromCharCode(65 + i);
const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

// sheet1.xml, sharedStrings.xml y core.xml del detalle.
export function partesDetalle(det, ahora = new Date()) {
  const textos = [], indice = new Map();
  let usos = 0;
  const ref = s => { usos++; if (!indice.has(s)) { indice.set(s, textos.length); textos.push(s) } return indice.get(s) };
  const celda = (c, r, v, estilo) => {
    const s = estilo != null ? ` s="${estilo}"` : "";
    if (v == null) return `<c r="${col(c)}${r}"${s}/>`;
    if (typeof v === "number") return `<c r="${col(c)}${r}"${s}><v>${v}</v></c>`;
    return `<c r="${col(c)}${r}"${s} t="s"><v>${ref(v)}</v></c>`;
  };
  const fila = (r, spans, celdas, extra = "") => `<row r="${r}" spans="${spans}"${extra} x14ac:dyDescent="0.25">${celdas.join("")}</row>`;
  const n = det.filas[0].length, ult = 10 + det.filas.length;
  const rows = [
    fila(1, "1:4", [celda(0, 1, det.titulo, 1), celda(1, 1, null, 1), celda(2, 1, null, 1), celda(3, 1, null, 1)], ' s="1" customFormat="1"'),
    fila(2, "1:4", [0, 1, 2, 3].map(c => celda(c, 2, null, 1))),
    fila(3, "1:1", [celda(0, 3, det.fecha, null)]),
    fila(5, "1:4", [celda(0, 5, "Detalle Nómina", 2), celda(1, 5, null, 2), celda(2, 5, null, 2), celda(3, 5, null, 2)]),
    ...det.cabecera.map((f, i) => fila(6 + i, "1:4", f.map((v, c) => celda(c, 6 + i, v, c % 2 ? 4 : 3)))),
    ...det.filas.map((f, i) => fila(11 + i, `1:${n}`, f.map((v, c) => celda(c, 11 + i, v, i ? 6 : 5)))),
  ];
  // Ancho de cada columna: el texto más largo desde la fila de encabezados, + 2.
  // Columnas seguidas con el mismo ancho van en un solo <col>, como en el archivo del banco.
  const anchos = Array.from({ length: n }, (_, c) => Math.max(...det.filas.map(f => String(f[c] ?? "").length)) + 2);
  const cols = [];
  anchos.forEach((w, c) => { const u = cols[cols.length - 1]; if (u && u.w === w && u.max === c) u.max = c + 1; else cols.push({ min: c + 1, max: c + 1, w }) });
  const hoja = DECL + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="x14ac" xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac">'
    + `<dimension ref="A1:${col(n - 1)}${ult}"/><sheetFormatPr defaultRowHeight="15" outlineLevelRow="0" outlineLevelCol="0" x14ac:dyDescent="55"/>`
    + `<cols>${cols.map(c => `<col min="${c.min}" max="${c.max}" width="${c.w}" customWidth="1"/>`).join("")}</cols>`
    + `<sheetData>${rows.join("")}</sheetData><mergeCells count="2"><mergeCell ref="A1:D2"/><mergeCell ref="A5:D5"/></mergeCells>`
    + '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/><pageSetup orientation="portrait" horizontalDpi="4294967295" verticalDpi="4294967295" scale="100" fitToWidth="1" fitToHeight="1"/></worksheet>';
  const sst = DECL + `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${usos}" uniqueCount="${textos.length}">`
    + textos.map(t => `<si><t${/^\s|\s$/.test(t) ? ' xml:space="preserve"' : ""}>${xmlEsc(t)}</t></si>`).join("") + "</sst>";
  const iso = ahora.toISOString().slice(0, 19) + "Z";
  const core = DECL + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
    + `<dc:creator>Unknown</dc:creator><dc:title></dc:title><dc:subject></dc:subject><dc:description></dc:description><cp:keywords></cp:keywords><cp:category></cp:category><cp:lastModifiedBy>Unknown</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${iso}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${iso}</dcterms:modified></cp:coreProperties>`;
  return { hoja, sst, core };
}

// Orden de las partes dentro del archivo, como en el del banco.
export const ORDEN_PARTES = ["[Content_Types].xml", "_rels/.rels", "xl/_rels/workbook.xml.rels", "xl/worksheets/sheet1.xml", "xl/sharedStrings.xml", "xl/theme/theme1.xml", "xl/styles.xml", "docProps/app.xml", "docProps/core.xml", "xl/workbook.xml"];

// Nombre del archivo, como el del banco: Detalle_Nomina_N__1234567_202610131112.xlsx
export const nombreDetalle = (n, ahora = new Date()) => {
  const dd = v => String(v).padStart(2, "0");
  return `Detalle_Nomina_N__${S(n.operacion) || n.num}_${ahora.getFullYear()}${dd(ahora.getMonth() + 1)}${dd(ahora.getDate())}${dd(ahora.getHours())}${dd(ahora.getMinutes())}.xlsx`;
};
