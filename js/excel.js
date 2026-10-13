// Excel idéntico a la planilla oficial BancoEstado y plantilla de documentos.
// Se parte de los .xlsx de assets/ y solo se escriben las filas de datos;
// el resto del archivo (logo, colores, comentarios, hojas de apoyo) no cambia.
// Usa JSZip (global, vendor/jszip-3.10.1.min.js).

import { ORDEN_PARTES } from "./detalle.js";

const MIME_XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const cache = {};
async function plantilla(ruta) {
  if (typeof JSZip === "undefined") throw new Error("no se cargó el generador de Excel");
  if (!cache[ruta]) cache[ruta] = fetch(ruta).then(r => { if (!r.ok) throw new Error("no se pudo leer " + ruta); return r.arrayBuffer() });
  try { return await JSZip.loadAsync(await cache[ruta]) }
  catch (e) { delete cache[ruta]; throw e }
}
const x = v => String(v).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// lineas: [{ tipo: 1|2, f: [...] }] tal como se guardan en pago_nominas.
export async function bankWorkbook(lineas) {
  const zip = await plantilla("assets/plantilla_bancoestado.xlsx");
  const path = "xl/worksheets/sheet1.xml";
  let xml = await zip.file(path).async("string");
  const str = (ref, s, v) => v === "" ? `<c r="${ref}" s="${s}"/>` : `<c r="${ref}" s="${s}" t="inlineStr"><is><t>${x(v)}</t></is></c>`;
  const num = (ref, s, v) => `<c r="${ref}" s="${s}"><v>${v}</v></c>`;
  let r = 4, rows = "";
  lineas.forEach(l => {
    r++; const f = l.f;
    if (l.tipo === 1) {
      rows += `<row r="${r}">` + str("A" + r, 20, "1") + str("B" + r, 21, f[1]) + str("C" + r, 22, f[2]) + str("D" + r, 23, f[3]) + str("E" + r, 24, f[4]) + str("F" + r, 24, f[5]) + str("G" + r, 21, f[6]) + str("H" + r, 18, f[7]) + num("I" + r, 25, f[8]) + `</row>`;
    } else {
      rows += `<row r="${r}">` + str("A" + r, 20, "2") + str("B" + r, 20, f[1]) + num("C" + r, 25, f[2]) + str("D" + r, 20, f[3]) + str("E" + r, 20, f[4]) + `<c r="H${r}" s="18"/></row>`;
    }
  });
  xml = xml.replace("</sheetData>", rows + "</sheetData>").replace(/<dimension ref="[^"]*"\/>/, `<dimension ref="A1:I${Math.max(r, 4)}"/>`);
  zip.file(path, xml);
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE", mimeType: MIME_XLSX });
}

// Plantilla de documentos con la hoja Fuentes rellenada (lista desplegable).
export async function docsTemplate(fuentes) {
  const zip = await plantilla("assets/plantilla_documentos.xlsx");
  const p = "xl/worksheets/sheet3.xml"; let xml = await zip.file(p).async("string");
  const fs = fuentes.slice(0, 40);
  const rows = fs.map((f, i) => `<row r="${i + 2}"><c r="A${i + 2}" t="inlineStr"><is><t>${x(f)}</t></is></c></row>`).join("");
  xml = xml.replace("</sheetData>", rows + "</sheetData>").replace(/<dimension ref="[^"]*"\/>/, `<dimension ref="A1:A${fs.length + 1}"/>`);
  zip.file(p, xml);
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE", mimeType: MIME_XLSX });
}

// Plantilla simple del paso 1 (proveedores y documentos), igual que la referencia.
export function plantillaSimple() {
  if (typeof XLSX === "undefined") throw new Error("el generador de Excel no cargó");
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["RUT", "NOMBRE", "EMAIL", "BANCO", "FORMA DE PAGO", "N CUENTA", "SECTOR"]]), "Proveedores");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["RUT", "FECHA DOC", "MONTO", "N DOC", "TIPO DOC", "FUENTE", "DC"]]), "Documentos");
  return new Uint8Array(XLSX.write(wb, { bookType: "xlsx", type: "array" }));
}

// Excel "Pago Solo Abonos DET" (7 columnas) desde assets/plantilla_abonos_7col.xlsx.
// La hoja DETALLE ya trae filas vacías con formato desde la 4: se reemplazan
// las necesarias por filas con datos, con los mismos estilos de la plantilla
// (A texto, B nombre, C email, D-E códigos centrados, F cuenta, G monto).
export async function abonosWorkbook(lineas) {
  const zip = await plantilla("assets/plantilla_abonos_7col.xlsx");
  const path = "xl/worksheets/sheet1.xml";
  let xml = await zip.file(path).async("string");
  const str = (ref, s, v) => v === "" ? `<c r="${ref}" s="${s}"/>` : `<c r="${ref}" s="${s}" t="inlineStr"><is><t>${x(v)}</t></is></c>`;
  const ultima = 3 + lineas.length;
  xml = xml.replace(/<row r="(\d+)"([^>]*)>[\s\S]*?<\/row>/g, (fila, n, attrs) => {
    const r = +n; if (r < 4 || r > ultima) return fila;
    const f = lineas[r - 4].f;
    return `<row r="${r}"${attrs}>` + str("A" + r, 8, f[0]) + str("B" + r, 7, f[1]) + str("C" + r, 1, f[2]) + str("D" + r, 74, f[3]) + str("E" + r, 74, f[4]) + str("F" + r, 1, f[5]) + `<c r="G${r}" s="44"><v>${x(f[6])}</v></c></row>`;
  });
  zip.file(path, xml);
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE", mimeType: MIME_XLSX });
}

// Planilla vacía del banco para completar a mano (la misma de assets/).
export async function plantillaAbonos() {
  const zip = await plantilla("assets/plantilla_abonos_7col.xlsx");
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE", mimeType: MIME_XLSX });
}

// Reporte de pagos: libro simple armado con SheetJS (global XLSX, vendor/xlsx-0.18.5.full.min.js).
// hojas: [{ nombre, filas, anchos }]; un monto viene como { $: número } y queda con formato de pesos.
export function libroReporte(hojas) {
  if (typeof XLSX === "undefined") throw new Error("no se cargó el generador de Excel");
  const wb = XLSX.utils.book_new();
  hojas.forEach(h => {
    const ws = XLSX.utils.aoa_to_sheet(h.filas.map(f => f.map(v => v && typeof v === "object" ? v.$ : v)));
    h.filas.forEach((f, r) => f.forEach((v, c) => { if (v && typeof v === "object") ws[XLSX.utils.encode_cell({ r, c })].z = '"$"#,##0;-"$"#,##0' }));
    ws["!cols"] = (h.anchos || []).map(wch => ({ wch }));
    XLSX.utils.book_append_sheet(wb, ws, h.nombre);
  });
  return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }));
}

// Detalle de Nómina en el formato que emite BancoEstado al terminar el proceso
// (js/detalle.js arma la hoja; las partes fijas salen de la plantilla).
// partes: resultado de partesDetalle. Van en el mismo orden que en el archivo del banco.
export async function libroDetalle(partes) {
  const base = await plantilla("assets/plantilla_detalle_nomina.xlsx");
  const variables = { "xl/worksheets/sheet1.xml": partes.hoja, "xl/sharedStrings.xml": partes.sst, "docProps/core.xml": partes.core };
  const zip = new JSZip();
  for (const p of ORDEN_PARTES) zip.file(p, variables[p] ?? await base.file(p).async("uint8array"));
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE", mimeType: MIME_XLSX });
}
