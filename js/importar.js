// Ingestión de proveedores y documentos: pegar desde Excel, importar
// .xls/.xlsx/.csv/.txt y reconocer una planilla de pago anterior del banco.
// Misma lógica que el panel de referencia, más la columna DC opcional.

import { S, normRut, rutOk, parseFecha, cleanName, normFuente, pad, normCuenta, parseMonto, normDc, conceptoDeNombre } from "./formato.js";
import { TIPOS, M_TIPO, M_BANCO, M_FORMA_ABONO, FORMAS_SIN_CUENTA } from "./catalogos.js";
import { codigoBanco } from "./comprobante.js";

// Tipo de documento: el código del SII ("33", "33 Factura…") o el nombre que
// escribe BancoEstado en su Detalle de Nómina ("FACTURA ELECTRONICA",
// "FACTURA NO AFECTA O EXENTA ELECTRONICA", "NOTA DE CREDITO ELECTRONICA").
const llaveTipo = v => cleanName(v).replace(/\b(DE|NO AFECTA O)\b/g, " ").replace(/\s+/g, " ").trim();
const TIPO_POR_NOMBRE = Object.fromEntries(TIPOS.map(([c, n]) => [llaveTipo(n), c]));
export function tipoDoc(v) {
  if (typeof v === "number") return pad(v, 2);
  const s = S(v); if (!s) return "";
  const cod = s.match(/^(\d{1,3})\b/);
  if (cod) return pad(cod[1], 2);
  return TIPO_POR_NOMBRE[llaveTipo(s)] || pad(s, 2);
}

// Detalle de Nómina de BancoEstado en la vista "Ver Documento": una cabecera
// con los datos de la nómina y una fila por documento, con "Tipo Documento"
// en texto y dos montos: "Monto Total $" (lo abonado al proveedor, que se
// repite en cada documento del mismo pago) y "Monto $" (el del documento).
// Las columnas se reconocen por su encabezado exacto, no por su posición.
const llave = v => S(v).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[º°]/g, "").replace(/\s+/g, " ").trim();
// "Nombre Nómina" de la cabecera del Detalle de Nómina (ej. PAGO_PROVEEDORES_FAEP), o "".
export function nombreNominaBanco(rows) {
  for (const r of rows.slice(0, 15)) for (const c of [0, 2]) if (llave(r && r[c]) === "nombre nomina") return S(r[c + 1]);
  return "";
}
export function detalleBancoPorDocumento(rows) {
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const h = (rows[i] || []).map(llave), col = re => h.findIndex(x => re.test(x));
    const m = { rut: col(/^rut$/), nombre: col(/^nombre$/), banco: col(/^banco$/), forma: col(/^(forma|tipo) abono$/), ndoc: col(/^n documento$/), tipo: col(/^tipo documento$/), fecha: col(/^fecha emision$/), monto: col(/^monto \$$/) };
    if (m.rut < 0 || m.ndoc < 0 || m.tipo < 0 || m.monto < 0) continue;
    return { inicio: i + 1, m, nombreNomina: nombreNominaBanco(rows.slice(0, i)) };
  }
  return null;
}

const RX = {
  fuente: /fuente|financiamiento|subvenci|programa|centro de costo/, rut: /^rut|rut (del )?(proveedor|beneficiario)/, nombre: /raz|nombre|beneficiario|proveedor/, email: /mail|correo/,
  forma: /forma|medio/, cuenta: /cuenta/, sector: /sector/, banco: /banco/, fecha: /fecha/, monto: /monto|importe|total/, ndoc: /(n.?|numero|número|nro|folio).*doc|^folio|^n.? ?doc/, tipo: /tipo/,
  dc: /^dc\b|^n.? ?dc\b/
};
const ORDER = ["fuente", "rut", "email", "forma", "cuenta", "sector", "fecha", "ndoc", "tipo", "monto", "banco", "nombre", "dc"];

export function headerMap(row) {
  const map = {};
  row.forEach((c, i) => {
    const h = S(c).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, ""); if (!h) return;
    for (const k of ORDER) { if (!(k in map) && RX[k].test(h)) { map[k] = i; break } }
  });
  return map;
}
export function isBankSheet(rows) {
  return rows.some(r => S(r[0]) === "1" && rutOk(normRut(r[1])) && r.length >= 9) && rows.some(r => S(r[0]) === "2" && parseFecha(r[1]));
}

// Filas (listas de celdas) → { provs, newDocs } sin normalizar.
export function ingest(rows, hint) {
  rows = rows.filter(r => r && r.some(c => S(c) !== ""));
  const provs = [], newDocs = [];
  if (!rows.length) return { provs, newDocs };
  const det = detalleBancoPorDocumento(rows);
  if (det) {
    // Sin N° de cuenta: el proveedor solo se agrega si no está en el maestro
    // (para completarlo en el paso 1); a uno que ya existe no se le toca nada.
    const g = (r, k) => det.m[k] >= 0 ? r[det.m[k]] : "", vistos = new Set();
    rows.slice(det.inicio).forEach(r => {
      const rut = normRut(g(r, "rut")); if (!rutOk(rut)) return;
      if (!vistos.has(rut)) { vistos.add(rut); provs.push({ rut, nombre: g(r, "nombre"), banco: codigoBanco(g(r, "banco")), forma: /ahorro/i.test(S(g(r, "forma"))) ? "02" : "01", soloNuevo: true }) }
      newDocs.push({ rut, fecha: g(r, "fecha"), monto: g(r, "monto"), ndoc: g(r, "ndoc"), tipo: g(r, "tipo"), fuente: hint || "" });
    });
    return { provs, newDocs, nombreNomina: det.nombreNomina };
  }
  if (isBankSheet(rows)) {
    let cur = null;
    rows.forEach(r => {
      const t = S(r[0]);
      if (t === "1" && rutOk(normRut(r[1]))) { cur = normRut(r[1]); provs.push({ rut: r[1], nombre: r[2], email: r[3], banco: r[4], forma: r[5], cuenta: r[6], sector: r[7] }) }
      else if (t === "2" && cur && parseFecha(r[1])) newDocs.push({ rut: cur, fecha: r[1], monto: r[2], ndoc: r[3], tipo: r[4], fuente: hint || "" });
    });
    return { provs, newDocs };
  }
  let map = null, start = 0;
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const m = headerMap(rows[i]);
    if ("rut" in m && Object.keys(m).length >= 3 && !rutOk(normRut(rows[i][m.rut]))) { map = m; start = i + 1; break }
  }
  if (!map) {
    const n = Math.max(...rows.map(r => { let k = r.length; while (k > 0 && S(r[k - 1]) === "") k--; return k }));
    const looksDoc = rows.filter(r => parseFecha(r[1])).length >= rows.length / 2;
    // Formato completo (11 o 12 columnas; la 13ª es DC) o de documentos (5 o 6; la 7ª es DC).
    if (n >= 11) map = { rut: 0, nombre: 1, email: 2, banco: 3, forma: 4, cuenta: 5, sector: 6, fecha: 7, monto: 8, ndoc: 9, tipo: 10, fuente: 11, dc: 12 };
    else if (looksDoc) map = { rut: 0, fecha: 1, monto: 2, ndoc: 3, tipo: 4, fuente: 5, dc: 6 };
    else map = { rut: 0, nombre: 1, email: 2, banco: 3, forma: 4, cuenta: 5, sector: 6 };
  }
  const hasProv = ("banco" in map) || ("cuenta" in map);
  const hasDoc = ("monto" in map) && ("ndoc" in map || "fecha" in map);
  rows.slice(start).forEach(r => {
    const g = k => k in map ? r[map[k]] : "";
    if (!S(g("rut"))) return;
    if (hasProv) provs.push({ rut: g("rut"), nombre: g("nombre"), email: g("email"), banco: g("banco"), forma: g("forma"), cuenta: g("cuenta"), sector: g("sector") });
    if (hasDoc) newDocs.push({ rut: g("rut"), fecha: g("fecha"), monto: g("monto"), ndoc: g("ndoc"), tipo: g("tipo"), fuente: g("fuente") || hint || "", dc: g("dc") });
  });
  return { provs, newDocs };
}

// Normaliza lo ingerido contra el maestro actual, sin escribir nada.
// Devuelve lo que hay que guardar y los documentos rechazados: Firestore
// exige monto entero mayor que cero, así que esos no se pueden guardar.
export function prepararIngesta({ provs, newDocs }, { maestro, fuentes, defFuente, pendientes = [] }) {
  const cambios = new Map(); // rut → { antes, despues }
  provs.forEach(p => {
    const rut = normRut(p.rut); if (!rut) return;
    if (p.soloNuevo && (maestro[rut] || cambios.has(rut))) return;
    const rec = { rut, nombre: cleanName(p.nombre), email: S(p.email), banco: pad(p.banco, 3), forma: pad(p.forma, 2) || "01", cuenta: normCuenta(p.cuenta), sector: pad(p.sector, 2) };
    const prev = cambios.has(rut) ? cambios.get(rut).despues : maestro[rut];
    let despues;
    if (prev) { despues = { ...prev }; for (const k in rec) if (rec[k]) despues[k] = rec[k] } else despues = rec;
    const antes = cambios.has(rut) ? cambios.get(rut).antes : (maestro[rut] || null);
    cambios.set(rut, { antes, despues });
  });
  let nNew = 0, nUpd = 0;
  for (const c of cambios.values()) c.antes ? nUpd++ : nNew++;
  const sinCuenta = [...cambios.values()].filter(c => !c.antes && !c.despues.cuenta).length;
  const docs = [], rechazados = [], nuevasFuentes = [], byF = {}, corregir = [];
  let repetidos = 0;
  const todas = [...fuentes];
  // Un documento que ya está pendiente (mismo RUT, N° y monto) no se vuelve a
  // agregar; si quedó sin un tipo válido y ahora viene con uno, se corrige.
  const clave = d => `${d.rut}|${d.ndoc}|${d.monto}`;
  const yaPendientes = new Map();
  pendientes.forEach(d => { const k = clave(d); if (!yaPendientes.has(k)) yaPendientes.set(k, []); yaPendientes.get(k).push(d) });
  newDocs.forEach(d => {
    const f = normFuente(d.fuente) || defFuente;
    const doc = { rut: normRut(d.rut), fecha: parseFecha(d.fecha), monto: parseMonto(d.monto), ndoc: S(typeof d.ndoc === "number" ? Math.round(d.ndoc) : d.ndoc), tipo: tipoDoc(d.tipo), fuente: f, sel: true };
    const dc = normDc(d.dc); if (dc) doc.dc = dc;
    if (!(Number.isInteger(doc.monto) && doc.monto > 0)) { rechazados.push({ ...doc, montoOriginal: S(d.monto) }); return }
    const previos = yaPendientes.get(clave(doc)) || [];
    const igual = previos.find(p => p.tipo === doc.tipo), aCorregir = !igual && M_TIPO[doc.tipo] && previos.find(p => !M_TIPO[p.tipo]);
    if (igual || aCorregir) {
      if (aCorregir) { corregir.push({ id: aCorregir.id, rut: doc.rut, ndoc: doc.ndoc, monto: doc.monto, antes: S(aCorregir.tipo), tipo: doc.tipo }); previos.splice(previos.indexOf(aCorregir), 1, { ...aCorregir, tipo: doc.tipo }) }
      else repetidos++;
      return;
    }
    yaPendientes.set(clave(doc), [...previos, doc]); // también evita repetirlo dentro del mismo archivo
    if (f && !todas.includes(f)) { todas.push(f); nuevasFuentes.push(f) }
    byF[f] = (byF[f] || 0) + 1;
    docs.push(doc);
  });
  const sinTipo = docs.filter(d => !M_TIPO[d.tipo]).length;
  return { provs: [...cambios.values()], nNew, nUpd, sinCuenta, docs, rechazados, nuevasFuentes, fuentes: todas, byF, corregir, repetidos, sinTipo };
}

export function parsePaste(text) { return text.replace(/\r/g, "").split("\n").map(l => l.split(/\t|;/)) }

// Texto delimitado (CSV del maestro, .txt del banco). Se lee como texto y no
// con SheetJS para no perder ceros a la izquierda ni dígitos de cuentas largas.
export function parseDelimitado(text) {
  text = text.replace(/^﻿/, "");
  const first = (text.split(/\r?\n/).find(l => l.trim()) || "");
  const cuenta = c => first.split(c).length - 1;
  const sep = cuenta("\t") ? "\t" : cuenta(";") >= cuenta(",") ? ";" : ",";
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++ } else q = false }
      else cell += ch;
    } else if (ch === '"' && cell === "") q = true;
    else if (ch === sep) { row.push(cell); cell = "" }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = "" }
    else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row) }
  return rows;
}
function decodificar(buf) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buf) }
  catch (e) { return new TextDecoder("windows-1252").decode(buf) } // CSV guardado por Excel en Windows
}

export function fuenteFromName(name, fuentes) {
  const up = cleanName(name.replace(/[_\-.]/g, " ")); const words = up.split(" ");
  return fuentes.filter(f => f.split(" ").every(w => words.includes(w))).sort((a, b) => b.length - a.length)[0] || "";
}

// Lee un archivo y devuelve { provs, newDocs }. Usa SheetJS (global XLSX).
export async function readFile(file, fuentes) {
  const hint = fuenteFromName(file.name, fuentes);
  const buf = await file.arrayBuffer();
  if (/\.(csv|txt)$/i.test(file.name)) return ingest(parseDelimitado(decodificar(buf)), hint);
  if (typeof XLSX === "undefined") throw new Error("no se pudo cargar el lector de Excel. Pega las filas en su lugar");
  const wb = XLSX.read(buf, { type: "array", cellDates: false });
  const name = wb.SheetNames.find(n => /detalle/i.test(n)) || wb.SheetNames[0];
  let rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: "" });
  if (!isBankSheet(rows) && wb.SheetNames.length > 1 && !/detalle/i.test(name)) {
    const all = { provs: [], newDocs: [] };
    wb.SheetNames.filter(n => !/instruc|lista|fuente|ayuda/i.test(n)).forEach(n => { const r = ingest(XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: "" }), hint); all.provs.push(...r.provs); all.newDocs.push(...r.newDocs) });
    return all;
  }
  const r = ingest(rows, hint);
  // Detalle del banco: la fuente también puede venir en el nombre de la nómina (ej. PAGO_PROVEEDORES_FAEP).
  const f = !hint && r.nombreNomina ? fuenteFromName(r.nombreNomina, fuentes) : "";
  if (f) r.newDocs.forEach(d => { d.fuente = f });
  return r;
}

// =====================================================================
// Remuneraciones y abonos (planilla Solo Abonos DET, 7 columnas)
// Columnas: RUT ⇥ Nombre ⇥ Email ⇥ Banco ⇥ Forma ⇥ N° cuenta ⇥ Monto,
// y opcionales ⇥ Fuente ⇥ Glosa. Acepta la hoja DETALLE del banco
// (encabezado en la fila 3) o filas pegadas, con o sin encabezado.
// =====================================================================
// Banco y forma de pago: el código ("012", "30") o el texto que escribe
// BancoEstado en su Detalle de Nómina ("BANCO DEL ESTADO DE CHILE",
// "Abono en CuentaRUT", "Abono en Cuenta Corriente / Cuenta Vista", "Pago Cash").
export const bancoCodigo = v => typeof v === "number" || /^\s*\d+\s*$/.test(S(v)) ? pad(v, 3) : codigoBanco(v);
export function formaAbono(v) {
  if (typeof v === "number" || /^\s*\d+\s*$/.test(S(v))) return pad(v, 2);
  const t = cleanName(v);
  if (!t) return "";
  if (/CUENTA ?RUT/.test(t)) return "30";
  if (/AHORRO/.test(t)) return "02";
  if (/CHEQUERA/.test(t)) return "22";
  if (/CASH/.test(t)) return "29";
  if (/VALE VISTA/.test(t)) return ""; // el banco usa varios códigos para vale vista: que lo elija la persona
  if (/CORRIENTE|VISTA|CUENTA/.test(t)) return "01";
  return "";
}

const RXA = {
  rut: /^rut/, nombre: /nombre|raz|beneficiario/, email: /mail|correo/, banco: /banco/,
  forma: /forma|medio/, cuenta: /cuenta/, monto: /monto|importe|total/, fuente: /fuente|financiamiento|subvenci|programa/, glosa: /glosa|detalle|concepto|observ|motivo/
};
const ORDERA = ["rut", "email", "forma", "cuenta", "monto", "fuente", "banco", "glosa", "nombre"];
function headerMapAbonos(row) {
  const map = {};
  row.forEach((c, i) => {
    const h = S(c).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""); if (!h) return;
    for (const k of ORDERA) { if (!(k in map) && RXA[k].test(h)) { map[k] = i; break } }
  });
  return map;
}
export function ingestAbonos(rows) {
  rows = rows.filter(r => r && r.some(c => S(c) !== ""));
  let map = null, start = 0;
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const m = headerMapAbonos(rows[i]);
    if ("rut" in m && "monto" in m && !rutOk(normRut(rows[i][m.rut]))) { map = m; start = i + 1; break }
  }
  if (!map) map = { rut: 0, nombre: 1, email: 2, banco: 3, forma: 4, cuenta: 5, monto: 6, fuente: 7, glosa: 8 };
  const out = [];
  rows.slice(start).forEach(r => {
    const g = k => k in map ? r[map[k]] : "";
    if (!S(g("rut")) || /^rut$/i.test(S(g("rut")))) return;
    out.push({ rut: g("rut"), nombre: g("nombre"), email: g("email"), banco: g("banco"), forma: g("forma"), cuenta: g("cuenta"), monto: g("monto"), fuente: g("fuente"), glosa: g("glosa") });
  });
  return out;
}

// Normaliza lo ingerido. Rechaza (no guarda) los de monto inválido, como en
// documentos: Firestore exige monto entero mayor que cero.
export function prepararAbonos(filas, { fuentes, defFuente, concepto, pendientes = [] }) {
  const abonos = [], rechazados = [], nuevasFuentes = [], byF = {}, corregir = [];
  const todas = [...fuentes];
  let corregidos = 0, repetidos = 0;
  // Pendientes del mismo RUT y monto: si ya está igual, no se repite; si quedó
  // con banco o forma inválidos (una importación anterior), se corrige.
  const libres = [...pendientes];
  const valido = a => M_BANCO[a.banco] && M_FORMA_ABONO[a.forma];
  filas.forEach(a => {
    const f = normFuente(a.fuente) || defFuente;
    const nombre = cleanName(a.nombre);
    if (nombre && nombre !== S(a.nombre).replace(/\s+/g, " ")) corregidos++;
    const forma = formaAbono(a.forma);
    const o = { rut: normRut(a.rut), nombre, email: S(a.email), banco: bancoCodigo(a.banco), forma, cuenta: FORMAS_SIN_CUENTA.has(forma) ? "" : normCuenta(a.cuenta), monto: parseMonto(a.monto), fuente: f, concepto: S(concepto) || "REMUNERACIONES", sel: true };
    const gl = S(a.glosa).replace(/\s+/g, " ").slice(0, 80); if (gl) o.glosa = gl;
    if (!(Number.isInteger(o.monto) && o.monto > 0)) { rechazados.push({ ...o, montoOriginal: S(a.monto) }); return }
    const mismo = libres.findIndex(p => p.rut === o.rut && p.monto === o.monto && p.banco === o.banco && p.forma === o.forma && S(p.cuenta) === o.cuenta);
    if (mismo >= 0) { libres.splice(mismo, 1); repetidos++; return }
    const roto = valido(o) ? libres.findIndex(p => p.rut === o.rut && p.monto === o.monto && !valido(p)) : -1;
    if (roto >= 0) {
      const p = libres.splice(roto, 1)[0];
      corregir.push({ id: p.id, antes: p, despues: { ...p, nombre: o.nombre || p.nombre, banco: o.banco, forma: o.forma, cuenta: o.cuenta, fuente: o.fuente, concepto: o.concepto } });
      return;
    }
    if (f && !todas.includes(f)) { todas.push(f); nuevasFuentes.push(f) }
    byF[f] = (byF[f] || 0) + 1;
    abonos.push(o);
  });
  return { abonos, rechazados, nuevasFuentes, fuentes: todas, byF, corregidos, corregir, repetidos };
}

// Lee un archivo de abonos (.xlsx/.xls de la planilla del banco, .csv o .txt).
export async function readAbonosFile(file, fuentes) {
  const buf = await file.arrayBuffer();
  let rows;
  if (/\.(csv|txt)$/i.test(file.name)) rows = parseDelimitado(decodificar(buf));
  else {
    if (typeof XLSX === "undefined") throw new Error("no se pudo cargar el lector de Excel. Pega las filas en su lugar");
    const wb = XLSX.read(buf, { type: "array", cellDates: false });
    const name = wb.SheetNames.find(n => /detalle/i.test(n)) || wb.SheetNames[0];
    // raw:true: los números llegan completos (sin notación científica); los códigos se rellenan con ceros después.
    rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: "" });
  }
  // La fuente y el concepto se deducen del nombre del archivo o, en el
  // Detalle de Nómina del banco, del nombre de la nómina (ej. P02_FONDO_FIJO_GENERAL).
  const nomina = nombreNominaBanco(rows);
  const hint = fuenteFromName(file.name, fuentes) || (nomina ? fuenteFromName(nomina, fuentes) : "");
  const concepto = conceptoDeNombre(file.name) || (nomina ? conceptoDeNombre(nomina) : "");
  return { filas: ingestAbonos(rows), hint, concepto, nomina };
}
