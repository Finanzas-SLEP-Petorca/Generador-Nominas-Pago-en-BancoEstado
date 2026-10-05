// Paso 4: bitácora de nóminas, resultado del banco e historial.

import { M_TIPO, EST_PAGO } from "../catalogos.js";
import { S, normRut, fmtRut, money, fmtFecha, fmtISO, isoLocal, todayISO, resultadoDesde, fmtDue, diaHabilSiguiente, esHabil, nombreDe, nomStatus, nombreNomina, toTxt, today, reportePagos, reporteHojas, reporteNominaHojas, nombreReporteNomina, esCobroCaja, porCobrar, noCobrado, tipoDe, TIPOS_REGISTRO, conDocumentos, conAbonos } from "../formato.js";
import { bankWorkbook, abonosWorkbook, libroReporte } from "../excel.js";
import { pdfReporte, pdfNomina, cargarPdf } from "../pdf.js";
import { M_FORMA_ABONO } from "../catalogos.js";
import { st, aFecha, suscribirHistorial, cargarNomina, guardarCarga, deshacerCarga, resultadoPago, pagarPendientes, cobroPago, volverPendientes, anularNomina, editarTransferencia, aplicarResultadosBanco, exportarRespaldo } from "../datos.js";
import { leerArchivoBanco, repartir } from "../conciliar.js";
import { $, esc, toast, accion, descargar, prefs, guardarPrefs, mensajeError } from "./comun.js";
import { fechaHora } from "./paso1.js";

let openNom = null, bitView = "", detallePendiente = false;
let conc = null;   // lectura del reporte del banco pendiente de aplicar
let histNom = { id: null, lista: [], baja: null };

const esAbonos = n => n.tipo === "abonos";
const status = n => nomStatus(n, st.config.feriados);
const creada = n => { const d = aFecha(n.creadaAt); return d ? fmtISO(isoLocal(d)) : "" };
// Nombre corto bajo la fecha en la tabla (el correo completo queda en el título).
const quien = email => email ? `<span class="hint" style="display:block" title="${esc(email)}">${esc(nombreDe(email))}</span>` : "";
const normDcQ = v => S(v).toLowerCase().replace(/\s+/g, "");
const TARJETAS = [["generada", "Generadas sin cargar"], ["espera", "Esperando resultado"], ["revisar", "Por registrar resultado"], ["reintegrar", "Con rechazos por reintegrar"], ["cobro", "Por cobrar en banco"], ["ok", "Pagadas"]];
const pagadoDe = n => n.pagos.filter(p => p.estado === "pagado" && !noCobrado(n, p)).reduce((a, p) => a + p.monto, 0);
const noCobradoDe = n => n.pagos.filter(p => noCobrado(n, p)).reduce((a, p) => a + p.monto, 0);
const porCobrarDe = n => n.pagos.filter(p => porCobrar(n, p)).reduce((a, p) => a + p.monto, 0);
const COBRO = { "": "Pendiente de cobro", cobrado: "Cobrado", devuelto: "No cobrado (devuelto)" };

// Período del reporte de pagos: por defecto, el mes en curso.
const hoy = () => todayISO();
const mesDe = (d, delta = 0) => { const a = new Date(d.getFullYear(), d.getMonth() + delta, 1), b = new Date(d.getFullYear(), d.getMonth() + delta + 1, 0); return [todayISO(a), todayISO(b)] };
let rep = { periodo: mesDe(new Date()), tipo: "*", fuente: "*" };

export function abrirNomina(id) { openNom = id; renderBit() }

export function init() {
  $("hSearch").oninput = () => renderBit();
  $("hFuente").onchange = () => { prefs.bitFuente = $("hFuente").value; guardarPrefs(); renderBit() };
  $("hTipo").value = prefs.bitTipo || "*";
  $("hTipo").onchange = () => { prefs.bitTipo = $("hTipo").value; guardarPrefs(); renderBit() };
  $("hAnul").onchange = () => renderBit();
  // No se redibuja el detalle mientras se escribe en él (llegan cambios de otros usuarios).
  $("hDetail").addEventListener("focusout", () => setTimeout(() => { if (detallePendiente && !escribiendo()) { detallePendiente = false; renderNomDetail() } }, 0));
  $("btnBitCsv").onclick = () => {
    const nominas = st.nominas;
    if (!nominas.length) { toast("La bitácora está vacía"); return }
    const q = v => { v = S(v); return /[;"\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v };
    const rows = [["N NOMINA", "FUENTE", "FECHA GENERACION", "GENERADA POR", "ESTADO NOMINA", "FECHA CARGA", "CARGADA POR", "FECHA PAGO", "N NOMINA BANCOESTADO", "RUT", "BENEFICIARIO", "MONTO PAGO", "RESULTADO", "MOTIVO RECHAZO", "REINTEGRADO", "N DOC", "TIPO DOC", "FECHA DOC", "MONTO DOC", "DC", "TIPO NOMINA", "CONCEPTO", "GLOSA", "COBRO EN BANCO", "FECHA COBRO"]];
    nominas.slice().sort((a, b) => a.num - b.num).forEach(n => { const s = status(n); n.pagos.forEach(p => p.docs.forEach(d => rows.push([n.num, n.fuente, creada(n), n.creadaPor, s.t, fmtISO(n.fechaCarga), n.cargadaPor, fmtISO(n.fechaPago), n.operacion, p.rut, p.nombre, p.monto, n.estado === "anulada" ? "Anulada" : EST_PAGO[p.estado], p.motivo, fmtISO(p.reint), d.ndoc, d.tipo, fmtFecha(d.fecha), d.monto, d.dc, TIPOS_REGISTRO[tipoDe(n)].toUpperCase(), d.concepto || n.concepto, d.glosa, esCobroCaja(n, p) && p.estado === "pagado" ? COBRO[p.cobro || ""] : "", fmtISO(p.cobroFecha)]))) });
    descargar("bitacora_nominas_" + today() + ".csv", "﻿" + rows.map(r => r.map(q).join(";")).join("\r\n"));
  };
  $("fReporteBanco").onchange = e => { const fs = [...e.target.files]; e.target.value = ""; if (fs.length) leerReportes(fs) };
  $("btnIrReporte").onclick = () => $("cardReporte").scrollIntoView({ behavior: "smooth", block: "start" });
  $("bitFiltro").onclick = e => { if (e.target.closest("[data-vertodas]")) { bitView = ""; renderBit() } };
  $("rDesde").onchange = () => { rep.periodo = [$("rDesde").value, rep.periodo[1]]; renderReporte() };
  $("rHasta").onchange = () => { rep.periodo = [rep.periodo[0], $("rHasta").value]; renderReporte() };
  $("rTipo").onchange = () => { rep.tipo = $("rTipo").value; renderReporte() };
  $("rFuente").onchange = () => { rep.fuente = $("rFuente").value; renderReporte() };
  document.querySelectorAll("[data-rper]").forEach(b => b.onclick = () => {
    const k = b.dataset.rper;
    rep.periodo = k === "hoy" ? [hoy(), hoy()] : k === "mes" ? mesDe(new Date()) : k === "ant" ? mesDe(new Date(), -1) : ["", ""];
    renderReporte();
  });
  // Excel y PDF del reporte: mismo período, filtros y tablas.
  const armarReporte = () => {
    const r = reportePagos(st.nominas, filtroReporte());
    if (!r.nominas.length) { toast("No hay nóminas cargadas con fecha de pago en ese período"); return null }
    const [d, h] = rep.periodo;
    const nombre = "reporte_pagos_" + (d || h ? (d || "inicio").replace(/-/g, "") + "_" + (h || "hoy").replace(/-/g, "") : "todo");
    const tipos = { "*": "Todas", ...TIPOS_REGISTRO };
    const meta = { desde: d, hasta: h, filtros: `Tipo: ${tipos[rep.tipo]} · Fuente: ${rep.fuente === "*" ? "Todas" : rep.fuente}`, generado: fmtISO(todayISO()) + " " + new Date().toTimeString().slice(0, 5), por: nombreDe(st.email) };
    return { r, nombre, meta };
  };
  $("btnReporte").onclick = () => {
    const a = armarReporte(); if (!a) return;
    try { descargar(a.nombre + ".xlsx", libroReporte(reporteHojas(a.r, a.meta))) }
    catch (e) { toast("No se pudo armar el reporte: " + mensajeError(e)) }
  };
  $("btnReportePdf").onclick = () => {
    const a = armarReporte(); if (!a) return;
    accion($("btnReportePdf"), async () => {
      try { descargar(a.nombre + ".pdf", pdfReporte(a.r, a.meta, await cargarPdf())) }
      catch (e) { toast("No se pudo armar el PDF: " + mensajeError(e)) }
    });
  };
  $("btnBackup").onclick = () => descargar("respaldo_panel_pago_" + today() + ".json", JSON.stringify(exportarRespaldo(), null, 1));
}

export function renderBitCount() {
  const act = st.nominas.map(status).filter(s => ["generada", "revisar", "reintegrar"].includes(s.k)).length;
  // Como en Control de DC: solo el número; ámbar si hay nóminas por atender.
  const c = $("cntBit");
  c.textContent = act || st.nominas.length || "";
  c.dataset.alerta = act ? "1" : "";
  c.title = act ? `${act} nómina${act > 1 ? "s" : ""} por atender` : `${st.nominas.length} nóminas en la bitácora`;
}

export function renderBit() {
  const nominas = st.nominas;
  const st2 = nominas.map(n => ({ n, s: status(n) }));
  const cnt = k => st2.filter(x => x.s.k === k).length;
  // Cada tarjeta filtra la tabla; en "Pagadas" el monto es lo pagado, en "Por cobrar" lo que falta retirar
  // en el banco, y en el resto el total de las nóminas.
  const monto = k => st2.filter(x => x.s.k === k).reduce((a, x) => a + (k === "ok" ? pagadoDe(x.n) : k === "cobro" ? porCobrarDe(x.n) : x.n.total), 0);
  $("bitStats").innerHTML = TARJETAS.map(([k, t]) => `<button class="stat" data-k="${k}" aria-pressed="${bitView === k}" title="${bitView === k ? "Toca de nuevo para ver todas" : "Ver solo estas nóminas"}"><b>${cnt(k)}</b><span>${t}</span><small>${money(monto(k))}</small></button>`).join("");
  const fil = $("bitFiltro"); fil.hidden = !bitView;
  if (bitView) fil.innerHTML = `Mostrando solo <b>${esc(TARJETAS.find(c => c[0] === bitView)[1].toLowerCase())}</b>. <button class="btn small" data-vertodas>Ver todas</button>`;
  $("bitStats").querySelectorAll(".stat").forEach(b => b.onclick = () => { bitView = bitView === b.dataset.k ? "" : b.dataset.k; renderBit() });
  const fus = [...new Set(nominas.map(n => n.fuente))];
  $("hFuente").innerHTML = `<option value="*">Todas</option>` + fus.map(f => `<option value="${esc(f)}"${f === prefs.bitFuente ? " selected" : ""}>${esc(f)}</option>`).join("");
  const q = S($("hSearch").value).toLowerCase(), qr = normRut(q), qd = q.replace(/\D/g, ""), qdc = normDcQ(q);
  // DC: "dc 54", "DC54" o "54" encuentran el documento con DC "DC 54".
  const dcMatch = dc => !!dc && !!qdc && (normDcQ(dc) === qdc || normDcQ(dc) === "dc" + qdc);
  const docMatch = (p, d) => q && ((qd && d.ndoc === qd) || (qr.length >= 7 && p.rut.includes(qr)) || dcMatch(d.dc));
  // Si lo buscado es el N° que BancoEstado dio a una nómina, se muestra solo esa (aunque el número calce con parte de un RUT).
  const esBanco = n => !!n.operacion && S(n.operacion).toLowerCase() === q;
  const porBanco = !!q && nominas.some(esBanco);
  const nomMatch = n => porBanco ? esBanco(n) : !q || n.pagos.some(p => S(p.nombre).toLowerCase().includes(q) || p.docs.some(d => docMatch(p, d))) || String(n.num) === q.replace(/^n.?\s*/, "");
  let list = st2.filter(x => (!prefs.bitTipo || prefs.bitTipo === "*" || prefs.bitTipo === tipoDe(x.n)) && (prefs.bitFuente === "*" || x.n.fuente === prefs.bitFuente) && ($("hAnul").checked || x.s.k !== "anulada") && (!bitView || x.s.k === bitView) && nomMatch(x.n));
  list.sort((a, b) => b.n.num - a.n.num);
  $("tbBit").innerHTML = list.length ? list.map(({ n, s }) => `<tr class="clickable${n.id === openNom ? " cur" : ""}" data-id="${esc(n.id)}" tabindex="0"><td class="mono"><b>${n.num}</b></td><td class="mono">${n.operacion ? `<b>${esc(n.operacion)}</b>` : n.estado === "cargada" ? `<span class="tag wrn" title="Abre la nómina y anota el N° que asignó BancoEstado">Falta</span>` : "—"}</td><td>${esc(n.fuente)}<span class="hint" style="display:block">${tipoDe(n) === "transferencia" ? "Transferencia" + (n.concepto ? " · " + esc(n.concepto.toLowerCase()) : "") : esAbonos(n) ? "Remuneraciones" + (n.concepto ? " · " + esc(n.concepto.toLowerCase()) : "") : "Proveedores"}</span></td><td>${creada(n)}${quien(n.creadaPor)}</td><td>${n.fechaCarga ? fmtISO(n.fechaCarga) : "—"}${n.fechaCarga ? quien(n.cargadaPor) : ""}</td><td>${n.fechaPago ? fmtISO(n.fechaPago) : "—"}</td><td class="num">${n.pagos.length}</td><td class="num">${money(n.total)}</td><td><span class="tag ${s.c}">${esc(s.t)}</span></td></tr>`).join("")
    : `<tr><td colspan="9" class="empty">${nominas.length ? "Ninguna nómina coincide con el filtro." : "Aún no hay nóminas. Genera la primera en el paso 3."}</td></tr>`;
  // Tocar una nómina abre su detalle; tocar la misma otra vez lo cierra.
  $("tbBit").querySelectorAll("tr[data-id]").forEach(tr => {
    const o = () => {
      const cerrar = openNom === tr.dataset.id;
      openNom = cerrar ? null : tr.dataset.id; renderBit();
      if (!cerrar) $("hDetail").scrollIntoView({ behavior: "smooth", block: "start" });
    };
    tr.onclick = o; tr.onkeydown = e => { if (e.key === "Enter") o() };
    tr.title = openNom === tr.dataset.id ? "Toca de nuevo para cerrar el detalle" : "Ver detalle";
  });
  // trazabilidad de un documento
  const tr = [];
  if (q && !porBanco && (qd || qr.length >= 7 || qdc.startsWith("dc"))) {
    const seenDoc = {};
    nominas.slice().sort((a, b) => a.num - b.num).forEach(n => n.pagos.forEach(p => p.docs.forEach(d => { if (!docMatch(p, d)) return; const key = p.rut + "|" + d.tipo + "|" + d.ndoc; (seenDoc[key] = seenDoc[key] || { p, d, h: [] }).h.push({ n, p }) })));
    Object.values(seenDoc).slice(0, 20).forEach(({ p, d, h }) => {
      tr.push(`<li><b>Doc ${esc(d.ndoc)}</b> (${esc(M_TIPO[d.tipo] || d.tipo)})${d.dc ? " " + esc(d.dc) : ""} de ${esc(p.nombre)}, ${money(d.monto)}: ` + h.map(({ n, p }) => `<a data-go="${esc(n.id)}">N° ${n.num} ${esc(n.fuente)}</a> ${n.estado === "anulada" ? "anulada" : n.estado === "generada" ? "generada sin cargar" : EST_PAGO[p.estado].toLowerCase() + (p.estado === "rechazado" && p.motivo ? " (" + esc(p.motivo) + ")" : "") + (n.fechaCarga ? ", cargada " + fmtISO(n.fechaCarga) : "") + (n.fechaPago ? ", pago " + fmtISO(n.fechaPago) : "")}`).join("; ") + `</li>`);
    });
    const pend = st.docs.filter(d => (qd && S(d.ndoc) === qd) || (qr.length >= 7 && d.rut.includes(qr)) || dcMatch(d.dc));
    if (pend.length) tr.push(`<li>${pend.length} documento${pend.length > 1 ? "s" : ""} coincidente${pend.length > 1 ? "s" : ""} sigue${pend.length > 1 ? "n" : ""} en pendientes (paso 2).</li>`);
  }
  $("hTrace").innerHTML = tr.join("");
  $("hTrace").querySelectorAll("[data-go]").forEach(a => a.onclick = () => { openNom = a.dataset.go; renderBit() });
  renderConciliacion();
  renderNomDetail();
  renderReporte();
}

const filtroReporte = () => ({ desde: rep.periodo[0], hasta: rep.periodo[1], tipo: rep.tipo, fuente: rep.fuente });

// Reporte de pagos: resumen en pantalla del período elegido (se actualiza en tiempo real).
function renderReporte() {
  $("rDesde").value = rep.periodo[0]; $("rHasta").value = rep.periodo[1]; $("rTipo").value = rep.tipo;
  const fus = [...new Set(st.nominas.map(n => n.fuente))];
  if (rep.fuente !== "*" && !fus.includes(rep.fuente)) rep.fuente = "*";
  $("rFuente").innerHTML = `<option value="*">Todas</option>` + fus.map(f => `<option value="${esc(f)}"${f === rep.fuente ? " selected" : ""}>${esc(f)}</option>`).join("");
  const r = reportePagos(st.nominas, filtroReporte()), t = r.tot;
  $("rKpis").innerHTML = `<div class="kpi hero"><span class="kpi-t">Pagado</span><b>${money(t.pagado)}</b><small>${t.nPagado} pago${t.nPagado === 1 ? "" : "s"} en ${t.nominas} nómina${t.nominas === 1 ? "" : "s"}${t.porCobrar ? ` · ${money(t.porCobrar)} por cobrar en banco` : ""}</small></div>`
    + `<div class="kpi"><span class="kpi-t">Rechazado</span><b>${money(t.rechazado)}</b><small>${t.nRechazado} pago${t.nRechazado === 1 ? "" : "s"}</small></div>`
    + `<div class="kpi"><span class="kpi-t">Pendiente de resultado</span><b>${money(t.pendiente)}</b><small>${t.nPendiente} pago${t.nPendiente === 1 ? "" : "s"}</small></div>`;
  $("tbReporte").innerHTML = r.resumen.length ? r.resumen.map(g => `<tr><td>${g.tipo}</td><td>${esc(g.fuente)}</td><td class="num">${g.nominas}</td><td class="num"><b>${money(g.pagado)}</b></td><td class="num">${money(g.rechazado)}</td><td class="num">${money(g.pendiente)}</td><td class="num">${money(g.porCobrar)}</td></tr>`).join("")
    + (r.resumen.length > 1 ? `<tr><td colspan="2"><b>Total</b></td><td class="num"><b>${t.nominas}</b></td><td class="num"><b>${money(t.pagado)}</b></td><td class="num"><b>${money(t.rechazado)}</b></td><td class="num"><b>${money(t.pendiente)}</b></td><td class="num"><b>${money(t.porCobrar)}</b></td></tr>` : "")
    : `<tr><td colspan="7" class="empty">No hay nóminas cargadas con fecha de pago en este período.</td></tr>`;
}

const escribiendo = () => { const a = document.activeElement; return $("hDetail").contains(a) && (a.tagName === "INPUT" || a.tagName === "TEXTAREA") };

// Historial de la nómina abierta (pago_historial con ref "nomina:N").
function seguirHistorial(n) {
  if (histNom.id === (n && n.id)) return;
  if (histNom.baja) histNom.baja();
  histNom = { id: n ? n.id : null, lista: [], baja: null };
  if (!n) return;
  histNom.baja = suscribirHistorial("nomina:" + n.num, lista => { histNom.lista = lista; const box = $("nHist"); if (box) box.innerHTML = htmlHistorial(lista) });
}
const htmlHistorial = lista => lista.length ? lista.map(h => `<li><b>${esc(h.accion)}</b> <span class="hint">${fechaHora(h.createdAt)} · ${esc(h.autor)}</span><br>${esc(h.detalle)}</li>`).join("") : `<li class="hint">Sin entradas.</li>`;

// ---------------------------------------------------------------------------
// Reporte de BancoEstado: se lee el Excel del banco, se reparte entre las
// nóminas por su N° BancoEstado y se muestra lo que cambiaría. Nada se escribe
// hasta que la persona lo aprueba. Solo se guardan las lecturas: la comparación
// se rehace en cada render contra st.nominas, así la vista previa no envejece
// si otro usuario registra algo mientras tanto.
// ---------------------------------------------------------------------------
async function leerReportes(files) {
  const lecturas = [];
  for (const f of files) {
    try { lecturas.push({ archivo: f.name, rep: await leerArchivoBanco(f) }) }
    catch (e) { lecturas.push({ archivo: f.name, rep: { ok: false, error: mensajeError(e) } }) }
  }
  conc = lecturas;
  renderConciliacion();
  $("cardConciliar").scrollIntoView({ behavior: "smooth", block: "start" });
}

const cerrarConciliacion = () => { conc = null; renderConciliacion() };

function renderConciliacion() {
  const box = $("cardConciliar");
  if (!conc || !conc.length) { box.hidden = true; box.innerHTML = ""; return }
  box.hidden = false;
  const res = repartir(conc, st.nominas);
  const total = res.reduce((a, r) => a + (r.cambios ? r.cambios.length : 0), 0);

  const bloques = res.map((r, k) => {
    const cab = `<div class="row" style="margin-top:0;justify-content:space-between"><b>${esc(r.archivo)}</b>${r.rep && r.rep.operacion ? `<span class="hint">BancoEstado N° ${esc(r.rep.operacion)}${r.rep.estadoNomina ? " · " + esc(r.rep.estadoNomina) : ""}</span>` : ""}</div>`;
    if (r.error) return `<div class="conc">${cab}<p class="hint" style="margin:6px 0 0"><span class="tag err">No se pudo usar</span> ${esc(r.error)}</p></div>`;
    const n = r.nomina, s = status(n);
    const filas = (r.cambios || []).map(c => `<tr><td class="mono">${esc(fmtRut(c.rut))}</td><td>${esc(c.nombre)}</td><td class="num">${money(c.monto)}</td><td><span class="tag ${c.estado === "pagado" ? "okk" : "err"}">${esc(EST_PAGO[c.estado] || c.estado)}</span>${c.cobro !== undefined ? ` <span class="hint">por cobrar en banco</span>` : ""}</td><td>${esc(c.motivo)}</td></tr>`).join("");
    const tabla = filas ? `<div class="tablebox"><table><thead><tr><th>RUT</th><th>Beneficiario</th><th style="text-align:right">Monto</th><th>Queda como</th><th>Motivo del banco</th></tr></thead><tbody>${filas}</tbody></table></div>` : "";
    const ya = (r.iguales || []).length ? `<p class="hint" style="margin:8px 0 0">${r.iguales.length} pago${r.iguales.length > 1 ? "s" : ""} ya ${r.iguales.length > 1 ? "estaban" : "estaba"} registrado${r.iguales.length > 1 ? "s" : ""} así; no se ${r.iguales.length > 1 ? "tocan" : "toca"}.</p>` : "";
    const avisos = (r.avisos || []).length ? `<ul class="hint" style="margin:8px 0 0;padding-left:18px">${r.avisos.map(a => `<li>${esc(a)}</li>`).join("")}</ul>` : "";
    const nada = !filas && !ya ? `<p class="hint" style="margin:6px 0 0">Nada que registrar desde este archivo.</p>` : "";
    return `<div class="conc">${cab}<p class="hint" style="margin:4px 0 0">Nómina <a data-conc-go="${esc(n.id)}">N° ${n.num}</a> · ${esc(n.fuente)} · ${esAbonos(n) ? "Remuneraciones" : "Proveedores"} · <span class="tag ${s.c}">${esc(s.t)}</span></p>${tabla}${ya}${avisos}${nada}</div>`;
  }).join("");

  box.innerHTML = `<div class="row" style="margin-top:0;justify-content:space-between"><h2 style="margin:0">Reporte de BancoEstado</h2><button class="btn small" id="concCerrar">Cerrar ✕</button></div>
    <p class="sub" style="margin-top:4px">Esto es lo que se registraría. Revísalo y aplícalo; hasta entonces no se escribe nada. Un pago cuyo monto no calce con el del banco, o con un estado que el panel no reconozca, se deja para registrar a mano.</p>
    ${bloques}
    <div class="row">${total ? `<button class="btn primary" id="concAplicar">Registrar ${total} resultado${total > 1 ? "s" : ""}</button>` : `<span class="hint">No hay resultados nuevos que registrar.</span>`}<button class="btn" id="concCancelar">Cancelar</button></div>`;

  $("concCerrar").onclick = cerrarConciliacion;
  $("concCancelar").onclick = cerrarConciliacion;
  box.querySelectorAll("[data-conc-go]").forEach(a => a.onclick = () => { openNom = a.dataset.concGo; renderBit(); $("hDetail").scrollIntoView({ behavior: "smooth", block: "start" }) });
  const btn = $("concAplicar");
  if (btn) btn.onclick = () => accion(btn, async () => {
    // Una transacción por nómina: si dos archivos son de la misma, se agrupan.
    const porNomina = new Map();
    res.forEach(r => {
      if (r.error || !r.cambios || !r.cambios.length) return;
      const e = porNomina.get(r.nomina.id) || { n: r.nomina, archivos: [], resultados: new Map() };
      e.archivos.push(r.archivo);
      r.cambios.forEach(c => e.resultados.set(c.rut + "|" + c.monto, { rut: c.rut, monto: c.monto, estado: c.estado, motivo: c.motivo }));
      porNomina.set(r.nomina.id, e);
    });
    let aplicados = 0; const problemas = [];
    for (const e of porNomina.values()) {
      try {
        const out = await aplicarResultadosBanco(e.n.id, [...e.resultados.values()], e.archivos.join(", "));
        aplicados += (out && out.aplicados) || 0;
        (out && out.omitidos || []).forEach(o => problemas.push(`N° ${e.n.num}: ${o}`));
      } catch (err) { problemas.push(`N° ${e.n.num}: ${mensajeError(err)}`); }
    }
    conc = null; renderBit();
    toast(aplicados
      ? `${aplicados} resultado${aplicados > 1 ? "s" : ""} registrado${aplicados > 1 ? "s" : ""} desde el reporte del banco` + (problemas.length ? `. ${problemas.length} quedaron sin aplicar` : "")
      : problemas.length ? "No se registró nada: " + problemas[0] : "No había nada que registrar");
    if (problemas.length) console.warn("Sin aplicar:", problemas);
  });
}

function renderNomDetail() {
  const box = $("hDetail"); const n = st.nominas.find(x => x.id === openNom);
  seguirHistorial(n);
  if (!n) { box.hidden = true; return }
  if (escribiendo() && box.dataset.id === n.id) { detallePendiente = true; return }
  box.dataset.id = n.id;
  box.hidden = false; const s = status(n);
  const cargada = n.estado === "cargada", anul = n.estado === "anulada", tef = tipoDe(n) === "transferencia";
  const conCobro = n.pagos.some(p => esCobroCaja(n, p));
  // Con columna de cobro, "Volver a pendientes" va dentro de la celda del motivo o del cobro, para que la tabla quepa.
  const reintegro = (p, i) => { const e = conCobro ? `<div style="margin-top:4px">` : "", c = conCobro ? "</div>" : ""; return p.reint ? `${e}<span class="hint">Reintegrado ${fmtISO(p.reint)}</span>${c}` : anul || (!conDocumentos(n) && !conAbonos(n)) ? "" : `${e}<button class="btn small" data-pr="${i}">Volver a pendientes</button>${c}` };
  const celdaCobro = (p, i) => !esCobroCaja(n, p) || p.estado !== "pagado" ? "" : `<select class="inl" data-co="${i}" ${cargada && !p.reint ? "" : "disabled"} aria-label="Cobro en banco">${Object.entries(COBRO).map(([k, t]) => `<option value="${k}"${(p.cobro || "") === k ? " selected" : ""}>${t}</option>`).join("")}</select>${p.cobro ? `<input type="date" class="inl" data-cf="${i}" value="${esc(p.cobroFecha || "")}" ${cargada && !p.reint ? "" : "disabled"} aria-label="Fecha de ${p.cobro === "cobrado" ? "cobro" : "devolución"}" title="Fecha de ${p.cobro === "cobrado" ? "cobro" : "devolución a la cuenta"}" style="margin-top:4px;width:150px;display:block">` : ""}`;
  const due = n.fechaCarga ? resultadoDesde(n, st.config.feriados) : null;
  const pend = n.pagos.filter(p => p.estado === "pendiente").length, pag = n.pagos.filter(p => p.estado === "pagado"), rech = n.pagos.filter(p => p.estado === "rechazado");
  // Reporte de pago de esta nómina: el respaldo de lo pagado, en Excel y PDF (no es el formato del banco).
  const botonesReporte = `<button class="btn" id="nRepXlsx" title="Respaldo de lo pagado en esta ${tef ? "transferencia" : "nómina"}: ficha, totales, detalle, rechazos e historial">Reporte de pago (Excel)</button><button class="btn" id="nRepPdf" title="El mismo reporte en PDF">Reporte de pago (PDF)</button>`;
  const topNom = () => `
  <div class="row" style="margin-top:0;justify-content:space-between"><h2 style="margin:0">Nómina N° ${n.num}${n.operacion ? ` <span class="hint" style="font-size:.7em">· BancoEstado N° ${esc(n.operacion)}</span>` : ""}, ${esc(n.fuente)}${esAbonos(n) ? ` · remuneraciones${n.concepto ? " (" + esc(n.concepto.toLowerCase()) + ")" : ""}` : ""}</h2><span class="row" style="margin-top:0"><span class="tag ${s.c}">${esc(s.t)}</span><button class="btn small" id="nCerrar" title="Cerrar el detalle">Cerrar ✕</button></span></div>
  <p class="due">Generada el ${creada(n)}${n.creadaPor ? ` por <b title="${esc(n.creadaPor)}">${esc(nombreDe(n.creadaPor))}</b>` : ""}.${n.fechaCarga ? ` Cargada en BancoEstado el ${fmtISO(n.fechaCarga)}${n.cargadaPor ? ` por <b title="${esc(n.cargadaPor)}">${esc(nombreDe(n.cargadaPor))}</b>` : ""}.` : ""} Archivo ${esc(nombreNomina(n))}.txt. ${n.pagos.length} pago${n.pagos.length === 1 ? "" : "s"} por ${money(n.total)}.${n.fechaPago ? ` Fecha de pago: ${fmtISO(n.fechaPago)}.` : ""}${cargada ? ` Pagado ${money(pagadoDe(n))}${noCobradoDe(n) ? `, no cobrado ${money(noCobradoDe(n))}` : ""}, rechazado ${money(rech.reduce((a, p) => a + p.monto, 0))}, pendiente de resultado ${money(n.pagos.filter(p => p.estado === "pendiente").reduce((a, p) => a + p.monto, 0))}${porCobrarDe(n) ? `, por cobrar en banco ${money(porCobrarDe(n))}` : ""}.` : ""}</p>
  <div class="grid">
    <label>Fecha de carga en BancoEstado<input type="date" id="nFecha" value="${n.fechaCarga || todayISO()}" ${anul ? "disabled" : ""}></label>
    <label title="Día en que el banco paga la nómina. Queda registrada aunque después haya pagos rechazados.">Fecha de pago de la nómina<input type="date" id="nFechaPago" value="${n.fechaPago || diaHabilSiguiente(n.fechaCarga || todayISO(), st.config.feriados)}" ${anul ? "disabled" : ""}></label>
    <label title="El número que BancoEstado asigna a la nómina al cargarla. Sirve para buscarla después en el banco.">N° de nómina BancoEstado<input id="nOper" value="${esc(n.operacion)}" inputmode="numeric" placeholder="Ej. 1234567" ${anul ? "disabled" : ""}></label>
    <label class="wide">Observación<input id="nObs" value="${esc(n.obs)}" ${anul ? "disabled" : ""}></label>
  </div>
  ${due ? `<p class="hint" style="margin-top:8px">Resultado del banco disponible desde el ${fmtDue(due)} (${n.fechaPago ? "14:00 del día de pago de la nómina; si cae en día no hábil, del hábil siguiente" : "día hábil siguiente a la carga"}; considera los feriados de Configuración).</p>` : ""}
  <div class="row">
    ${n.estado === "generada" ? `<button class="btn primary" id="nCargar">Marcar como cargada en BancoEstado</button>` : ""}
    ${cargada ? `<button class="btn" id="nGuardar">Guardar cambios</button>` : ""}
    ${cargada && pend ? `<button class="btn primary" id="nPagarRest">Marcar ${pend} pendiente${pend > 1 ? "s" : ""} como pagado${pend > 1 ? "s" : ""}</button>` : ""}
    <button class="btn" id="nTxt">Descargar .txt</button>
    <button class="btn" id="nXlsx">Descargar Excel BancoEstado</button>
    ${cargada ? botonesReporte : ""}
    ${n.estado === "generada" ? `<button class="btn danger" id="nAnular">Anular nómina</button>` : ""}
    ${cargada && n.pagos.every(p => p.estado === "pendiente") ? `<button class="btn small" id="nDescargar" title="Vuelve al estado generada">Deshacer carga</button>` : ""}
  </div>
  ${cargada && pend && Date.now() < due.getTime() ? `<p class="hint">Si el banco rechaza algún pago, márcalo como Rechazado con su motivo. Al resto le puedes aplicar “Marcar pendientes como pagados”.</p>` : ""}
  ${anul ? `<p class="hint">Nómina anulada: queda cerrada y no se puede volver a editar.</p>` : ""}
`;
  // Transferencia electrónica: datos del comprobante; nace pagada, no tiene archivo ni carga.
  const topTef = () => `
  <div class="row" style="margin-top:0;justify-content:space-between"><h2 style="margin:0">Transferencia N° ${esc(n.operacion)} <span class="hint" style="font-size:.7em">· registro N° ${n.num}</span>, ${esc(n.fuente)}</h2><span class="row" style="margin-top:0"><span class="tag ${s.c}">${esc(s.t)}</span><button class="btn small" id="nCerrar" title="Cerrar el detalle">Cerrar ✕</button></span></div>
  <p class="due">Transferencia electrónica del ${fmtISO(n.fechaPago)}${n.horaTef ? " " + esc(n.horaTef) : ""}, ${money(n.total)}, desde la cuenta ${esc(n.cuentaOrigen)}${n.cuentaNombre ? " (" + esc(n.cuentaNombre) + ")" : ""}.${n.idTef ? ` ID TEF ${esc(n.idTef)}.` : ""} Registrada el ${creada(n)}${n.creadaPor ? ` por <b title="${esc(n.creadaPor)}">${esc(nombreDe(n.creadaPor))}</b>` : ""}. ${n.origen === "documentos" ? "Paga documentos del paso 2." : n.origen === "abonos" ? "Paga abonos de Remuneraciones." : "Pago sin documento en el panel."}</p>
  <div class="grid">
    <label>N° de transferencia<input id="tOper" value="${esc(n.operacion)}" inputmode="numeric" ${anul ? "disabled" : ""}></label>
    <label>ID TEF<input id="tIdTef" value="${esc(n.idTef)}" inputmode="numeric" ${anul ? "disabled" : ""}></label>
    <label>Hora<input type="time" id="tHoraD" value="${esc(n.horaTef)}" ${anul ? "disabled" : ""}></label>
    <label>Concepto<input id="tConceptoD" value="${esc(n.concepto)}" ${anul ? "disabled" : ""}></label>
    <label>Mensaje al beneficiario<input id="tMensajeD" value="${esc(n.mensaje)}" ${anul ? "disabled" : ""}></label>
    <label>Preparó<input id="tPreparoD" value="${esc(n.preparo)}" ${anul ? "disabled" : ""}></label>
    <label>Autorizó<input id="tAutorizoD" value="${esc(n.autorizo)}" ${anul ? "disabled" : ""}></label>
    <label class="wide">Observación<input id="tObsD" value="${esc(n.obs)}" ${anul ? "disabled" : ""}></label>
  </div>
  <div class="row">
    ${cargada ? `<button class="btn" id="tGuardar">Guardar cambios</button>` : ""}
    ${cargada ? botonesReporte : ""}
    ${cargada && !n.pagos.some(p => p.reint) ? `<button class="btn danger" id="tAnular" title="Solo si se registró por error: la fecha, la fuente y el monto no se editan">Anular transferencia</button>` : ""}
  </div>
  ${cargada ? `<p class="hint">La fecha, la cuenta de origen, el beneficiario y el monto no se editan: si alguno quedó mal, anula la transferencia y regístrala de nuevo.${!conDocumentos(n) && !conAbonos(n) ? "" : " Si el banco la rechazara, márcala como Rechazada y usa “Volver a pendientes”."}</p>` : ""}
  ${anul ? `<p class="hint">Transferencia anulada: queda cerrada y no se puede volver a editar.</p>` : ""}`;
  box.innerHTML = `
  ${tef ? topTef() : topNom()}
  ${conCobro && cargada ? `<p class="hint">Pago cash o vale vista: aunque el banco lo pague, queda <b>Pendiente de cobro</b> hasta que se retira. Marca <b>Cobrado</b> cuando se retire, o <b>No cobrado</b> si los fondos volvieron a la cuenta; en ese caso “Volver a pendientes” lo deja listo para pagarlo de nuevo.</p>` : ""}
  <div class="tablebox"><table>
    <thead><tr><th>Beneficiario</th><th>Cuenta</th><th>${conDocumentos(n) ? "Documentos" : conAbonos(n) ? "Abonos" : "Detalle"}</th><th style="text-align:right">Monto</th><th>Resultado</th><th>Motivo de rechazo</th>${conCobro ? `<th title="Pago cash o vale vista: queda pendiente de cobro hasta que se retira en el banco">Cobro en banco</th>` : "<th></th>"}</tr></thead>
    <tbody>${n.pagos.map((p, i) => `<tr>
      <td><span class="mono">${esc(fmtRut(p.rut))}</span><br>${esc(p.nombre)}</td>
      <td class="mono"${p.forma ? ` title="${esc(M_FORMA_ABONO[p.forma] || "")}"` : ""}>${esc(p.banco)}${p.forma ? " · " + esc(p.forma) + " ·" : ""} ${esc(p.cuenta) || "sin cuenta"}</td>
      <td>${!conDocumentos(n) ? p.docs.map(d => `<span class="hint">${esc(d.concepto || n.concepto)}${d.glosa ? " · " + esc(d.glosa) : ""} ${money(d.monto)}</span>`).join("<br>") : p.docs.map(d => `<span class="mono">${esc(d.ndoc)}</span> <span class="hint">${esc((M_TIPO[d.tipo] || d.tipo))} ${money(d.monto)}${d.dc ? " · " + esc(d.dc) : ""}</span>`).join("<br>")}</td>
      <td class="num">${money(p.monto)}</td>
      <td><select class="inl" data-pe="${i}" ${cargada && !p.reint && !p.cobro ? "" : "disabled"}${p.cobro ? ` title="Vuelve el cobro a «Pendiente de cobro» para cambiar el resultado"` : ""} aria-label="Resultado">${Object.entries(EST_PAGO).map(([k, t]) => `<option value="${k}"${p.estado === k ? " selected" : ""}>${t}</option>`).join("")}</select></td>
      <td>${p.estado === "rechazado" ? `<input class="inl" data-pm="${i}" value="${esc(p.motivo)}" placeholder="Ej. cuenta inexistente" ${cargada ? "" : "disabled"}>` : ""}${conCobro && p.estado === "rechazado" ? reintegro(p, i) : ""}</td>
      ${conCobro ? `<td>${celdaCobro(p, i)}${noCobrado(n, p) ? reintegro(p, i) : ""}</td>` : `<td>${p.estado === "rechazado" ? reintegro(p, i) : ""}</td>`}
    </tr>`).join("")}</tbody>
  </table></div>
  <h3>Historial de la ${tef ? "transferencia" : "nómina"}</h3>
  <ul class="trace" id="nHist">${htmlHistorial(histNom.lista)}</ul>`;
  const q = id => box.querySelector("#" + id);
  q("nCerrar").onclick = () => { const id = openNom; openNom = null; renderBit(); const tr = $("tbBit").querySelector(`tr[data-id="${CSS.escape(id)}"]`); if (tr) tr.scrollIntoView({ behavior: "smooth", block: "center" }) };
  const datosCarga = () => ({ fechaCarga: q("nFecha").value, fechaPago: q("nFechaPago").value, operacion: S(q("nOper").value), obs: S(q("nObs").value) });
  // Mientras no se haya guardado ni tocado, la fecha de pago sigue al día hábil siguiente a la carga.
  let pagoTocado = !!n.fechaPago;
  if (q("nFechaPago")) q("nFechaPago").addEventListener("input", () => { pagoTocado = true });
  if (q("nFecha")) q("nFecha").addEventListener("change", () => { if (!pagoTocado && q("nFecha").value) q("nFechaPago").value = diaHabilSiguiente(q("nFecha").value, st.config.feriados) });
  const fechasOk = d => {
    if (!d.fechaCarga) { toast("Indica la fecha de carga"); return false }
    if (!d.fechaPago) { toast("Indica la fecha de pago de la nómina"); return false }
    if (d.fechaPago < d.fechaCarga) { toast("La fecha de pago no puede ser anterior a la fecha de carga"); return false }
    if (!esHabil(d.fechaPago, st.config.feriados) && !confirm(`La fecha de pago ${fmtISO(d.fechaPago)} cae en sábado, domingo o feriado. ¿Guardarla igual?`)) return false;
    return true;
  };
  // El N° BancoEstado identifica la nómina al leer el reporte del banco: no puede repetirse.
  const operRepetida = d => st.nominas.find(x => x.id !== n.id && x.estado !== "anulada" && tipoDe(x) !== "transferencia" && d.operacion && S(x.operacion) === d.operacion);
  const avisoRepetida = x => { toast(`El N° BancoEstado ${S(x.operacion)} ya es de la nómina N° ${x.num}`); q("nOper").focus() };
  if (q("nCargar")) q("nCargar").onclick = () => { const d = datosCarga(); if (!fechasOk(d)) return; if (!d.operacion) { toast("Indica el N° de nómina que asignó BancoEstado"); q("nOper").focus(); return } const rep2 = operRepetida(d); if (rep2) { avisoRepetida(rep2); return } accion(q("nCargar"), async () => { await cargarNomina(n.id, d); toast(`Nómina N° ${n.num} marcada como cargada el ${fmtISO(d.fechaCarga)}, con pago el ${fmtISO(d.fechaPago)}. Resultado desde el ${fmtDue(resultadoDesde(d, st.config.feriados))}`) }) };
  if (q("nGuardar")) q("nGuardar").onclick = () => { const d = datosCarga(); if (!fechasOk(d)) return; const rep2 = operRepetida(d); if (rep2) { avisoRepetida(rep2); return } accion(q("nGuardar"), async () => { await guardarCarga(n.id, d); toast("Cambios guardados") }) };
  if (q("nPagarRest")) q("nPagarRest").onclick = () => { if (Date.now() < due.getTime() && !confirm("Aún no es la hora del resultado del banco (14:00 del día de pago). ¿Marcar igual los pendientes como pagados?")) return; accion(q("nPagarRest"), async () => { await pagarPendientes(n.id); const sinR = n.pagos.some(p => p.estado === "rechazado" && !p.reint), caja = n.pagos.some(p => p.estado !== "rechazado" && esCobroCaja(n, p) && !p.cobro); toast(`Pagos pendientes marcados como pagados. La nómina N° ${n.num} queda en «${sinR ? "Con rechazos por reintegrar" : caja ? "Por cobrar en banco" : "Pagadas"}».`) }) };
  if (q("nTxt")) q("nTxt").onclick = () => descargar(nombreNomina(n) + ".txt", toTxt(n.lineas));
  const metaReporte = () => ({ estado: status(n).t, creada: creada(n), generado: fmtISO(todayISO()) + " " + new Date().toTimeString().slice(0, 5), por: nombreDe(st.email),
    historial: histNom.id === n.id ? histNom.lista.map(h => ({ fecha: fechaHora(h.createdAt), accion: S(h.accion), detalle: S(h.detalle), autor: nombreDe(h.autor) })) : [] });
  if (q("nRepXlsx")) q("nRepXlsx").onclick = () => {
    try { descargar(nombreReporteNomina(n) + ".xlsx", libroReporte(reporteNominaHojas(n, metaReporte()))) }
    catch (e) { toast("No se pudo armar el reporte: " + mensajeError(e)) }
  };
  if (q("nRepPdf")) q("nRepPdf").onclick = () => accion(q("nRepPdf"), async () => {
    try { descargar(nombreReporteNomina(n) + ".pdf", pdfNomina(n, metaReporte(), await cargarPdf())) }
    catch (e) { toast("No se pudo armar el PDF: " + mensajeError(e)) }
  });
  if (q("nXlsx")) q("nXlsx").onclick = () => accion(q("nXlsx"), async () => { try { descargar(nombreNomina(n) + ".xlsx", await (esAbonos(n) ? abonosWorkbook : bankWorkbook)(n.lineas)) } catch (e) { toast("No se pudo armar el Excel: " + mensajeError(e)) } });
  if (q("nAnular")) q("nAnular").onclick = () => { if (!confirm(`¿Anular la nómina N° ${n.num}? Sus ${n.pagos.reduce((a, p) => a + p.docs.length, 0)} ${esAbonos(n) ? "abonos" : "documentos"} vuelven a pendientes. Hazlo solo si no se cargó en el banco.`)) return; accion(q("nAnular"), async () => { await anularNomina(n.id); toast(`Nómina anulada; ${esAbonos(n) ? "abonos de vuelta en la pestaña Remuneraciones" : "documentos de vuelta en pendientes"}`) }) };
  if (q("tGuardar")) q("tGuardar").onclick = () => {
    const d = { operacion: S(q("tOper").value), idTef: S(q("tIdTef").value), horaTef: q("tHoraD").value, concepto: S(q("tConceptoD").value), mensaje: S(q("tMensajeD").value), preparo: S(q("tPreparoD").value), autorizo: S(q("tAutorizoD").value), obs: S(q("tObsD").value) };
    if (!d.operacion) { toast("El N° de transferencia no puede quedar vacío"); return }
    const otra = st.nominas.find(x => x.id !== n.id && tipoDe(x) === "transferencia" && x.estado !== "anulada" && S(x.operacion) === d.operacion);
    if (otra) { toast(`La transferencia N° ${d.operacion} ya está registrada (registro N° ${otra.num})`); return }
    accion(q("tGuardar"), async () => { await editarTransferencia(n.id, d); toast("Cambios guardados") });
  };
  if (q("tAnular")) q("tAnular").onclick = () => {
    const vuelve = conDocumentos(n) ? " Sus documentos vuelven a pendientes (paso 2)." : conAbonos(n) ? " Sus abonos vuelven a Remuneraciones." : "";
    if (!confirm(`¿Anular la transferencia N° ${n.operacion}? Hazlo solo si se registró por error.${vuelve}`)) return;
    accion(q("tAnular"), async () => { await anularNomina(n.id); toast("Transferencia anulada." + vuelve) });
  };
  if (q("nDescargar")) q("nDescargar").onclick = () => accion(q("nDescargar"), () => deshacerCarga(n.id));
  box.querySelectorAll("[data-pe]").forEach(sel => sel.onchange = () => {
    const p = n.pagos[+sel.dataset.pe];
    if (p.reint && sel.value !== "rechazado") { toast("Este pago ya se reintegró a pendientes; no se puede cambiar"); sel.value = "rechazado"; return }
    accion(sel, () => resultadoPago(n.id, +sel.dataset.pe, sel.value, p.motivo));
  });
  box.querySelectorAll("[data-co]").forEach(sel => sel.onchange = () => {
    const i = +sel.dataset.co, f = box.querySelector(`[data-cf="${i}"]`);
    accion(sel, async () => { await cobroPago(n.id, i, sel.value, sel.value && f ? f.value : todayISO()); toast(`${n.pagos[i].nombre}: ${sel.value === "devuelto" ? "no cobrado, fondos devueltos a la cuenta" : COBRO[sel.value].toLowerCase()}`) });
  });
  box.querySelectorAll("[data-cf]").forEach(inp => inp.onchange = () => { const i = +inp.dataset.cf; if (inp.value) accion(null, () => cobroPago(n.id, i, n.pagos[i].cobro, inp.value)) });
  box.querySelectorAll("[data-pm]").forEach(inp => inp.onchange = () => accion(null, () => resultadoPago(n.id, +inp.dataset.pm, "rechazado", S(inp.value))));
  box.querySelectorAll("[data-pr]").forEach(b => b.onclick = () => { const p = n.pagos[+b.dataset.pr]; accion(b, async () => { await volverPendientes(n.id, +b.dataset.pr); toast(`${p.docs.length} ${conAbonos(n) ? "abono" : "documento"}${p.docs.length > 1 ? "s" : ""} de ${p.nombre} de vuelta en pendientes${conAbonos(n) ? " (pestaña Remuneraciones)" : ""}. Corrige los datos bancarios si hace falta.`) }) });
}
