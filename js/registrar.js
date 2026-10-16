// Nómina que se pagó en BancoEstado y no está en la bitácora (se subió fuera
// del panel): se arma desde su Detalle de Nómina con los pagos, sus estados y
// sus documentos, y se cruza con lo pendiente. Un documento o abono pendiente
// que viene en el archivo deja de estar pendiente: queda en esta nómina, como
// si se hubiera generado aquí. Funciones puras (sin DOM ni Firestore), se
// prueban en Node (tests/conciliar.test.mjs).

import { S, normRut, fmtRut, money, cleanName, conceptoDeNombre, tipoDe } from "./formato.js";
import { tipoDoc, bancoCodigo, formaAbono, fuenteFromName } from "./importar.js";
import { traducirEstado } from "./conciliar.js";
import { FORMAS_SIN_CUENTA, NC } from "./catalogos.js";

const ddmmaaaa = v => { const m = S(v).match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/); return m ? m[1].padStart(2, "0") + m[2].padStart(2, "0") + m[3] : S(v).replace(/\D/g, "") };
const iso = v => { const m = S(v).match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/); return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : "" };
const nDoc = v => S(v).replace(/^0+(?=\d)/, "");

// rep: lectura de leerReporteBanco. ctx: { fuentes, defFuente, maestro, docs, abonos, nominas }
// (docs y abonos: los pendientes, con su id). Devuelve { error } o lo que se
// registraría: { tipo, fuente, concepto, archivo, total, pagos, lineas,
// consumir: { docs: [ids], abonos: [ids] }, cruzados, resumen, avisos, datosCarga }.
export function nominaDesdeReporte(rep, ctx) {
  const { fuentes = [], defFuente = "GENERAL", maestro = {}, docs = [], abonos = [], nominas = [] } = ctx;
  const abonosTipo = rep.vista === "remuneraciones";
  // Proveedores en la vista Ver Nómina (una fila por pago, con N° de cuenta y sin documentos: así
  // las informa el banco en las nóminas más antiguas). Los folios salen de lo pendiente del panel.
  const porPago = rep.vista === "pagos";
  const nombre = S(rep.nombreNomina);
  const fuente = fuenteFromName(nombre, fuentes) || defFuente;
  const avisos = [];
  // Una entrada por RUT (y banco y forma): en la vista por documento el mismo pago viene en varias filas.
  const porClave = new Map(), pagos = [];
  rep.pagos.forEach(f => {
    const banco = bancoCodigo(f.banco), forma = formaAbono(f.forma);
    const clave = abonosTipo || porPago ? pagos.length : f.rut + "|" + banco + "|" + forma;
    let p = porClave.get(clave);
    if (!p) {
      const t = traducirEstado(f.estado);
      const m = maestro[f.rut];
      p = { rut: f.rut, nombre: cleanName(f.nombre), banco, forma,
        cuenta: abonosTipo || porPago ? (FORMAS_SIN_CUENTA.has(forma) ? "" : S(f.cuenta)) : (m && m.banco === banco ? S(m.cuenta) : ""),
        monto: 0, estado: t ? t.estado : "pendiente", motivo: t && t.estado === "rechazado" ? S(f.motivo) : "", reint: "", formaBanco: S(f.forma), bancoBanco: S(f.banco), docs: [] };
      // El nombre como lo escribe el banco, para emitir el Detalle de Nómina igual.
      const nombreBco = abonosTipo ? f.nombreTal || S(f.nombre) : S(f.nombre);
      if (nombreBco && nombreBco !== p.nombre) p.nombreBanco = nombreBco;
      // Cash o vale vista: "Pendiente de Cobro" queda por cobrar; "Pagado", ya cobrado en banco.
      if (t && t.cobro !== undefined) p.cobro = t.cobro;
      else if (t && t.estado === "pagado" && abonosTipo && FORMAS_SIN_CUENTA.has(forma)) { p.cobro = "cobrado"; p.cobroFecha = iso(rep.fechaPago) }
      if (!t) avisos.push(`${fmtRut(f.rut)} ${p.nombre}: el banco informa "${f.estado}"; queda pendiente y se registra después con su reporte.`);
      if (abonosTipo && m && m.email) p.email = S(m.email);
      porClave.set(clave, p); pagos.push(p);
    }
    if (abonosTipo) { p.monto = f.monto; p.docs.push({ monto: f.monto }) }
    else if (porPago) p.monto = f.monto;                                     // sus documentos salen del cruce
    else { const monto = f.montodoc || f.monto; p.monto += monto; p.docs.push({ fecha: ddmmaaaa(f.fechadoc), monto, ndoc: S(f.ndoc), tipo: tipoDoc(f.tipodoc), dc: "" }) }
  });
  if (!pagos.length) return { error: "El archivo no trae pagos." };

  // Cruce con lo pendiente: documentos por RUT y N° (y tipo si ambos lo traen); abonos por RUT y monto.
  const consumir = { docs: [], abonos: [] };
  let cruzados = 0, sinFolio = 0;
  const libres = abonosTipo ? abonos.slice() : docs.slice();
  // Vista por pago: el pago se cruza con los documentos pendientes de su RUT que suman su monto
  // (uno solo o varios; las notas de crédito restan). Si no se encuentran, queda sin folio.
  if (porPago) pagos.forEach(p => {
    const suyos = libres.filter(x => x.rut === p.rut);
    const val = x => NC.has(x.tipo) ? -x.monto : x.monto;
    const elegidos = combinacion(suyos, val, p.monto);
    if (elegidos === "varias") avisos.push(`${fmtRut(p.rut)} ${p.nombre} (${money(p.monto)}): varios documentos pendientes suman ese monto; se usó una combinación, revísala.`);
    const usa = Array.isArray(elegidos) ? elegidos : elegidos === "varias" ? combinacion(suyos, val, p.monto, true) : null;
    if (!usa) { sinFolio++; p.docs.push({ fecha: "", monto: p.monto, ndoc: "", tipo: "", dc: "" }); return }
    usa.forEach(x => { libres.splice(libres.indexOf(x), 1); cruzados++; consumir.docs.push(x.id);
      p.docs.push({ docId: x.id, fecha: S(x.fecha), monto: x.monto, ndoc: S(x.ndoc), tipo: S(x.tipo), dc: S(x.dc) }) });
  });
  else pagos.forEach(p => p.docs.forEach(d => {
    const k = abonosTipo
      ? libres.findIndex(a => a.rut === p.rut && a.monto === d.monto)
      : libres.findIndex(x => x.rut === p.rut && nDoc(x.ndoc) === nDoc(d.ndoc) && (!x.tipo || !d.tipo || x.tipo === d.tipo));
    if (k < 0) return;
    const x = libres.splice(k, 1)[0]; cruzados++;
    if (abonosTipo) { d.abonoId = x.id; d.concepto = S(x.concepto); d.glosa = S(x.glosa); consumir.abonos.push(x.id) }
    else { d.docId = x.id; d.dc = S(x.dc); if (!d.fecha) d.fecha = S(x.fecha); consumir.docs.push(x.id) }
  }));
  const concepto = abonosTipo ? (conceptoDeNombre(nombre) || "REMUNERACIONES") : "";
  if (abonosTipo) pagos.forEach(p => p.docs.forEach(d => { if (!d.concepto) d.concepto = concepto; if (!d.glosa) d.glosa = "" }));

  // Documentos que ya están en otra nómina de la bitácora: se avisa (puede ser el nuevo pago de un rechazo).
  if (!abonosTipo) {
    const en = new Map();
    nominas.filter(n => n.estado !== "anulada" && tipoDe(n) !== "abonos").forEach(n => (n.pagos || []).forEach(p => (p.docs || []).forEach(d => { if (S(d.ndoc)) en.set(p.rut + "|" + nDoc(d.ndoc), n.num) })));
    pagos.forEach(p => p.docs.forEach(d => { const num = S(d.ndoc) && en.get(p.rut + "|" + nDoc(d.ndoc)); if (num) avisos.push(`${fmtRut(p.rut)} ${p.nombre}: el documento ${d.ndoc} ya está en la nómina N° ${num}.`) }));
  }

  // Líneas como las del archivo que se sube al banco, para que la nómina quede igual a una generada aquí.
  const lineas = abonosTipo
    ? pagos.map(p => ({ tipo: 7, f: [p.rut, p.nombre, S(p.email), p.banco, p.forma, p.cuenta, String(p.monto)] }))
    : pagos.flatMap(p => [{ tipo: 1, f: ["1", p.rut, p.nombre, "", p.banco, p.forma, p.cuenta, "", String(p.monto)] },
        ...p.docs.map(d => ({ tipo: 2, f: ["2", d.fecha, String(d.monto), d.ndoc, d.tipo, "", "", "", ""] }))]);
  const total = rep.montoTotal || pagos.reduce((a, p) => a + p.monto, 0);
  const suma = pagos.reduce((a, p) => a + p.monto, 0);
  if (rep.montoTotal && suma !== rep.montoTotal) avisos.push(`La suma de los pagos (${money(suma)}) no cuadra con el total del banco (${money(rep.montoTotal)}).`);
  const cuenta = e => pagos.filter(p => p.estado === e);
  const fechaPago = iso(rep.fechaPago);
  return {
    tipo: abonosTipo ? "abonos" : "proveedores", fuente, concepto, archivo: nombre || "nomina_" + rep.operacion, total, pagos, lineas,
    consumir, cruzados, sinFolio, avisos,
    resumen: { pagados: cuenta("pagado").length, rechazados: cuenta("rechazado").length, pendientes: cuenta("pendiente").length, documentos: pagos.reduce((a, p) => a + p.docs.length, 0) },
    datosCarga: { fechaCarga: fechaPago, fechaPago, operacion: S(rep.operacion), obs: "Registrada desde el Detalle de Nómina de BancoEstado", nombreBanco: nombre, convenioBanco: S(rep.convenio),
      ...(S(rep.conceptoPago) ? { conceptoBanco: S(rep.conceptoPago) } : {}) }
  };
}

// Pagos de una nómina de proveedores registrados sin folio (el banco no informó sus documentos).
export const sinFolio = n => tipoDe(n) === "proveedores" ? n.pagos.filter(p => p.docs.length && p.docs.every(d => !S(d.ndoc))).length : 0;

// Completar después los folios de esos pagos con los documentos pendientes: los del mismo RUT
// que suman el monto del pago (como al registrarla). Devuelve { pagos: [{ i, rut, monto, nombre,
// docs }], sinFolio, avisos }; nada se escribe aquí.
export function planFolios(n, docs) {
  const libres = docs.slice(), pagos = [], avisos = [];
  const val = x => NC.has(x.tipo) ? -x.monto : x.monto;
  if (tipoDe(n) === "proveedores") n.pagos.forEach((p, i) => {
    if (!(p.docs.length && p.docs.every(d => !S(d.ndoc)))) return;
    const suyos = libres.filter(x => x.rut === p.rut);
    let usa = combinacion(suyos, val, p.monto);
    if (usa === "varias") { avisos.push(`${fmtRut(p.rut)} ${p.nombre} (${money(p.monto)}): varios documentos pendientes suman ese monto; se usó una combinación, revísala.`); usa = combinacion(suyos, val, p.monto, true) }
    if (!usa) return;
    usa.forEach(x => libres.splice(libres.indexOf(x), 1));
    pagos.push({ i, rut: p.rut, monto: p.monto, nombre: p.nombre, docs: usa.map(x => ({ docId: x.id, fecha: S(x.fecha), monto: x.monto, ndoc: S(x.ndoc), tipo: S(x.tipo), dc: S(x.dc) })) });
  });
  return { pagos, sinFolio: sinFolio(n), avisos };
}

// Documentos (de un mismo RUT) cuyo valor suma `objetivo`: primero uno solo, después
// combinaciones de más, hasta 16 documentos. Devuelve la lista, null si no hay, o
// "varias" si hay más de una combinación del menor tamaño (con primera=true, la primera).
function combinacion(docs, val, objetivo, primera = false) {
  const lista = docs.slice(0, 16);
  for (let tam = 1; tam <= lista.length; tam++) {
    const hallados = [];
    const buscar = (desde, elegidos, suma) => {
      if (hallados.length > 1) return;
      if (elegidos.length === tam) { if (suma === objetivo) hallados.push(elegidos.slice()); return }
      for (let i = desde; i < lista.length; i++) { elegidos.push(lista[i]); buscar(i + 1, elegidos, suma + val(lista[i])); elegidos.pop() }
    };
    buscar(0, [], 0);
    if (hallados.length === 1 || (hallados.length && primera)) return hallados[0];
    if (hallados.length > 1) return "varias";
  }
  return null;
}
