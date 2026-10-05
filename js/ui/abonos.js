// Pestaña Remuneraciones: nómina de abonos a personas naturales con la
// planilla BancoEstado "Pago Solo Abonos DET" (7 columnas), una por fuente.

import { BANCOS, FORMAS_ABONO, M_BANCO, M_FORMA_ABONO, CONCEPTOS } from "../catalogos.js";
import { S, normRut, rutOk, fmtRut, parseMonto, checkAbono, buildAbonos, ultimoAbono, toTxt, fileName, today, money } from "../formato.js";
import { ingestAbonos, parsePaste, prepararAbonos, readAbonosFile } from "../importar.js";
import { abonosWorkbook, plantillaAbonos } from "../excel.js";
import { st, agregarAbonos, editarAbono, actualizarAbonos, quitarAbonos, generarNominaAbonos } from "../datos.js";
import { $, esc, fillSelect, fOpts, toast, accion, descargar, prefs, guardarPrefs, go, mensajeError } from "./comun.js";
import { mostrarGenerada } from "./paso3.js";
import { abrirNomina } from "./paso4.js";

const LOGO = "assets/logo_bancoestado.png";
let prefijoEditado = false, current = null, editando = null;

const visibles = () => prefs.abFilt && prefs.abFilt !== "*" ? st.abonos.filter(a => a.fuente === prefs.abFilt) : st.abonos;
const conceptoOpts = sel => CONCEPTOS.map(c => `<option value="${c}"${c === sel ? " selected" : ""}>${c[0] + c.slice(1).toLowerCase()}</option>`).join("");
const construir = f => buildAbonos(f, { abonos: st.abonos, nominas: st.nominas, group: !!prefs.abGroup, email: st.config.emailDefecto });
const fuentesActivas = () => { const set = new Set(st.abonos.filter(a => a.sel).map(a => a.fuente)); return st.config.fuentes.filter(f => set.has(f)).concat([...set].filter(f => !st.config.fuentes.includes(f))) };
// Concepto de la nómina: el común de sus abonos; si hay varios, REMUNERACIONES.
function conceptoDe(r) { const cs = [...new Set(r.groups.flatMap(g => g.docs.map(d => d.concepto)).filter(Boolean))]; return cs.length === 1 ? cs[0] : "REMUNERACIONES" }
const prefijoSugerido = r => today() + "_" + conceptoDe(r).replace(/ /g, "_");
const nombreArchivo = r => fileName($("abPrefijo").value || prefijoSugerido(r), r.fuente, new Date(), st.config.fuentes);

async function ingestar(filas, origen, concepto) {
  const prep = prepararAbonos(filas, { fuentes: st.config.fuentes, defFuente: prefs.abDefFuente || st.config.fuentes[0], concepto, pendientes: st.abonos });
  if (!prep.abonos.length && !prep.rechazados.length && !prep.corregir.length && !prep.repetidos) { toast("No se reconocieron filas. Revisa el orden de las columnas."); return false }
  await agregarAbonos(prep, origen);
  let msg = prep.abonos.length ? `Agregado: ${prep.abonos.length} abonos por ${money(prep.abonos.reduce((t, a) => t + a.monto, 0))} (${Object.entries(prep.byF).map(([f, n]) => f + " " + n).join(", ")}), concepto ${concepto || "REMUNERACIONES"}` : "";
  if (prep.corregidos) msg += `. ${prep.corregidos} nombre${prep.corregidos > 1 ? "s" : ""} pasado${prep.corregidos > 1 ? "s" : ""} a mayúsculas sin tildes`;
  if (prep.nuevasFuentes.length) msg += ". Fuente nueva: " + prep.nuevasFuentes.join(", ");
  if (prep.rechazados.length) msg += `. ${prep.rechazados.length} fila${prep.rechazados.length > 1 ? "s" : ""} sin monto válido no se agregó`;
  if (prep.corregir.length) msg += `${msg ? ". " : ""}${prep.corregir.length} pendiente${prep.corregir.length > 1 ? "s" : ""} con banco y forma de pago corregidos (concepto ${concepto || "REMUNERACIONES"})`;
  if (prep.repetidos) msg += `${msg ? ". " : ""}${prep.repetidos} ya estaba${prep.repetidos > 1 ? "n" : ""} pendiente${prep.repetidos > 1 ? "s" : ""} y no se duplic${prep.repetidos > 1 ? "aron" : "ó"}`;
  const malos = prep.abonos.filter(a => checkAbono(a, st.config.emailDefecto).e.length).length;
  if (malos) msg += `. ${malos} con datos por revisar (● revisar)`;
  toast(msg);
  return true;
}

export function init() {
  fillSelect($("abBanco"), BANCOS); fillSelect($("abForma"), FORMAS_ABONO);
  $("abBanco").value = "012"; $("abForma").value = "01";
  $("abConcepto").innerHTML = conceptoOpts(prefs.abConcepto || "REMUNERACIONES");
  $("abConcepto1").innerHTML = conceptoOpts(prefs.abConcepto || "REMUNERACIONES");
  $("abConcepto").onchange = () => { prefs.abConcepto = $("abConcepto").value; guardarPrefs() };
  $("abDefFuente").onchange = () => { prefs.abDefFuente = $("abDefFuente").value; guardarPrefs() };
  $("abFiltro").onchange = () => { prefs.abFilt = $("abFiltro").value; guardarPrefs(); renderAbonos() };
  $("abAgrupar").checked = !!prefs.abGroup;
  $("abAgrupar").onchange = () => { prefs.abGroup = $("abAgrupar").checked; guardarPrefs(); renderAbonos() };
  $("abPrefijo").oninput = () => { prefijoEditado = true; if (current && current.nDocs) $("abArchivoInfo").textContent = "Archivo: " + nombreArchivo(current) + ".txt" };
  $("abVerPl").onclick = () => vista(true); $("abVerTx").onclick = () => vista(false);

  $("abBtnPegar").onclick = () => accion($("abBtnPegar"), async () => { if (await ingestar(ingestAbonos(parsePaste($("abPegar").value)), "pegado", $("abConcepto").value)) $("abPegar").value = "" });
  $("abArchivo").addEventListener("change", async e => {
    const file = e.target.files[0]; e.target.value = ""; if (!file) return;
    await accion(null, async () => {
      const r = await readAbonosFile(file, st.config.fuentes);
      // El concepto y la fuente se deducen del nombre del archivo cuando se puede.
      const concepto = r.concepto || $("abConcepto").value;
      const filas = r.hint ? r.filas.map(f => ({ ...f, fuente: f.fuente || r.hint })) : r.filas;
      await ingestar(filas, file.name, concepto);
    });
  });
  $("abBtnPlantilla").onclick = () => accion($("abBtnPlantilla"), async () => descargar("Formato_Pago_Solo_Abonos_DET_7_Columnas.xlsx", await plantillaAbonos()));

  // Alta manual: al escribir el RUT se completan los datos del último pago.
  $("abRut").addEventListener("change", () => {
    const rut = normRut($("abRut").value); if (!rut) { $("abRutInfo").textContent = ""; return }
    const u = ultimoAbono(st.nominas, rut), pend = st.abonos.find(a => a.rut === rut), prov = st.maestro[rut];
    const fuente = u ? { ...u.p, de: `del último pago (nómina N° ${u.num})` } : pend ? { ...pend, de: "de un abono pendiente" } : prov ? { ...prov, forma: "01", de: "del maestro de proveedores" } : null;
    if (!fuente) { $("abRutInfo").textContent = rutOk(rut) ? "RUT sin pagos anteriores: completa sus datos bancarios" : "RUT inválido"; return }
    $("abNombre").value = fuente.nombre || ""; $("abEmail").value = fuente.email || "";
    if (M_BANCO[fuente.banco]) $("abBanco").value = fuente.banco;
    if (M_FORMA_ABONO[fuente.forma]) $("abForma").value = fuente.forma;
    $("abCuenta").value = fuente.cuenta || "";
    $("abRutInfo").textContent = "Datos " + fuente.de + ". Revísalos antes de agregar.";
  });
  $("abBtnCancelar").onclick = () => formAbono(null);
  $("abBtnAgregar").onclick = () => {
    const a = { rut: $("abRut").value, nombre: $("abNombre").value, email: $("abEmail").value, banco: $("abBanco").value, forma: $("abForma").value, cuenta: $("abCuenta").value, monto: parseMonto($("abMonto").value), fuente: $("abFuente").value, glosa: $("abGlosa").value };
    const c = checkAbono(a, st.config.emailDefecto);
    if (c.e.length) { toast("No se agregó: " + c.e[0]); return }
    const o = { ...c.out, email: S(a.email), fuente: a.fuente, concepto: $("abConcepto1").value, sel: true };
    if (S(a.glosa)) o.glosa = S(a.glosa).slice(0, 80);
    if (editando) {
      const id = editando;
      accion($("abBtnAgregar"), async () => {
        const r = await editarAbono(id, { ...o, glosa: o.glosa || "" });
        formAbono(null);
        toast((r === "sin cambios" ? "Sin cambios" : "Abono actualizado") + (c.w.length ? ". Ojo: " + c.w[0] : ""));
      });
      return;
    }
    accion($("abBtnAgregar"), async () => {
      await agregarAbonos({ abonos: [o], nuevasFuentes: [], fuentes: st.config.fuentes, byF: { [o.fuente]: 1 } }, "alta manual");
      // Si mientras se guardaba se abrió otro abono para editar, no se toca el formulario.
      if (!editando) { ["abRut", "abNombre", "abEmail", "abCuenta", "abMonto", "abGlosa"].forEach(id => $(id).value = ""); $("abRutInfo").textContent = ""; $("abRut").focus() }
      toast("Abono agregado a " + o.fuente + (c.w.length ? ". Ojo: " + c.w[0] : ""));
    });
  };

  const marcar = (lista, sel) => accion(null, () => actualizarAbonos(lista.filter(a => a.sel !== sel).map(a => a.id), { sel }));
  $("abSelTodos").onclick = () => marcar(visibles(), true);
  $("abSelNinguno").onclick = () => marcar(visibles(), false);
  $("abChkTodos").onchange = e => marcar(visibles(), e.target.checked);
  $("abBtnMover").onclick = () => {
    const f = $("abMover").value, t = visibles().filter(a => a.sel);
    if (!t.length) { toast("No hay abonos marcados"); return }
    accion($("abBtnMover"), async () => { await actualizarAbonos(t.map(a => a.id), { fuente: f }); toast(t.length + " abonos movidos a " + f) });
  };
  $("abBtnQuitar").onclick = () => {
    const t = visibles().filter(a => a.sel); if (!t.length) { toast("No hay abonos marcados"); return }
    if (confirm(`¿Quitar ${t.length} abonos marcados de la lista?`)) accion($("abBtnQuitar"), () => quitarAbonos(t.map(a => a.id), "Quitar marcados"));
  };
  $("abBtnVaciar").onclick = () => {
    if (st.abonos.length && confirm(`¿Vaciar los ${st.abonos.length} abonos pendientes de todas las fuentes?`)) accion($("abBtnVaciar"), () => quitarAbonos(st.abonos.map(a => a.id), "Vaciar todo"));
  };

  $("abBtnBorrador").onclick = () => accion($("abBtnBorrador"), async () => {
    const r = renderAbonos(); if (!r || r.errs || !r.lines.length) return;
    descargar(nombreArchivo(r) + ".xlsx", await abonosWorkbook(r.lines));
  });
  $("abBtnGenerar").onclick = () => {
    const r = renderAbonos(); if (!r || r.errs || !r.lines.length) return;
    const num = st.nextNum, concepto = conceptoDe(r);
    if (!confirm(`Se registrará la nómina N° ${num} de remuneraciones (${concepto}, ${r.fuente}): ${r.nBen} pagos por ${money(r.total)}.\n\nSus ${r.nDocs} abonos salen de pendientes y quedan asociados a esta nómina. Luego se descargan el .txt y el Excel de 7 columnas.`)) return;
    accion($("abBtnGenerar"), async () => {
      const n = await generarNominaAbonos(r, nombreArchivo(r), concepto);
      prefijoEditado = false;
      abrirNomina(String(n.num)); go(4);
      const nombre = n.archivo, txt = toTxt(n.lineas);
      let xlsx = null, errXlsx = "";
      try { xlsx = await abonosWorkbook(n.lineas) } catch (e) { errXlsx = mensajeError(e) }
      descargar(nombre + ".txt", txt);
      if (xlsx) descargar(nombre + ".xlsx", xlsx);
      mostrarGenerada(n, nombre, txt, xlsx, errXlsx, n.num !== num ? num : null);
    });
  };
}

// Carga un abono en el formulario para editarlo (null vuelve al modo agregar).
function formAbono(a) {
  editando = a ? a.id : null;
  const v = (id, x) => { $(id).value = x == null ? "" : x };
  v("abRut", a && a.rut); v("abNombre", a && a.nombre); v("abEmail", a && a.email); v("abCuenta", a && a.cuenta);
  v("abMonto", a && a.monto); v("abGlosa", a && a.glosa);
  $("abBanco").value = a && M_BANCO[a.banco] ? a.banco : "012";
  $("abForma").value = a && M_FORMA_ABONO[a.forma] ? a.forma : "01";
  if (a) { $("abFuente").value = a.fuente; if (a.concepto) $("abConcepto1").value = a.concepto }
  $("abFormTitulo").textContent = a ? `Editar abono de ${fmtRut(a.rut)}` : "Agregar un abono";
  $("abBtnAgregar").textContent = a ? "Guardar cambios" : "Agregar abono";
  $("abBtnCancelar").hidden = !a;
  $("abRutInfo").textContent = a ? "Si cambias banco, forma o cuenta, el cambio queda en el historial con el antes y el después." : "";
  if (a) { $("abFormTitulo").scrollIntoView({ behavior: "smooth", block: "start" }); $("abMonto").focus({ preventScroll: true }) }
}

function vista(pl) { $("abVerPl").setAttribute("aria-pressed", pl); $("abVerTx").setAttribute("aria-pressed", !pl); $("abPrevPl").hidden = !pl; $("abPrevTx").hidden = pl }

export function renderAbonos() {
  $("abReglas").hidden = !st.abonosError;
  const fuentes = st.config.fuentes;
  if (!fuentes.includes(prefs.abDefFuente)) prefs.abDefFuente = fuentes[0];
  $("abDefFuente").innerHTML = fOpts(prefs.abDefFuente);
  $("abFuente").innerHTML = fOpts($("abFuente").value || prefs.abDefFuente);
  $("abMover").innerHTML = fOpts($("abMover").value || fuentes[0]);
  const usados = {}; st.abonos.forEach(a => usados[a.fuente] = (usados[a.fuente] || 0) + 1);
  if (prefs.abFilt && prefs.abFilt !== "*" && !usados[prefs.abFilt] && !fuentes.includes(prefs.abFilt)) prefs.abFilt = "*";
  $("abFiltro").innerHTML = `<option value="*">Todas las fuentes</option>` + fuentes.map(f => `<option value="${esc(f)}"${f === prefs.abFilt ? " selected" : ""}>${esc(f)} (${usados[f] || 0})</option>`).join("");

  // Lista de abonos pendientes
  const vis = visibles();
  $("abTabla").innerHTML = vis.length ? vis.map(a => {
    const c = checkAbono(a, st.config.emailDefecto);
    const aviso = c.e.length ? ` <span class="bad" title="${esc(c.e.join("; "))}">● revisar</span>` : "";
    return `<tr class="${a.sel ? "" : "off"}"><td class="c"><input type="checkbox" class="chk" data-absel="${esc(a.id)}"${a.sel ? " checked" : ""} aria-label="Pagar abono de ${esc(a.nombre)}"></td><td><select class="inl" data-abfu="${esc(a.id)}" aria-label="Fuente">${fOpts(a.fuente)}</select></td><td>${esc(a.concepto)}</td><td class="mono ${rutOk(a.rut) ? "" : "bad"}">${esc(fmtRut(a.rut))}</td><td>${a.hist ? `<span class="dochist">${esc(a.hist)}</span>` : ""}${esc(a.nombre)}${aviso}</td><td class="mono" title="${esc(M_FORMA_ABONO[a.forma] || "")}">${esc(a.banco)} ${esc((M_BANCO[a.banco] || "?").split(" /")[0])} · ${esc(a.forma)} · ${esc(c.out.cuenta) || "sin cuenta"}</td><td class="num">${money(a.monto)}</td><td>${esc(a.glosa)}</td><td><span class="row" style="margin:0;flex-wrap:nowrap"><button class="btn small" data-abed="${esc(a.id)}">Editar</button><button class="btn small danger" data-abdel="${esc(a.id)}">Quitar</button></span></td></tr>`;
  }).join("") : `<tr><td colspan="9" class="empty">${st.abonos.length ? "No hay abonos en esta fuente." : "No hay abonos pendientes. Importa la planilla del banco o pega filas arriba."}</td></tr>`;
  $("abTabla").querySelectorAll("[data-absel]").forEach(c => c.onchange = () => accion(null, () => actualizarAbonos([c.dataset.absel], { sel: c.checked })));
  $("abTabla").querySelectorAll("[data-abfu]").forEach(s => s.onchange = () => accion(null, () => actualizarAbonos([s.dataset.abfu], { fuente: s.value })));
  $("abTabla").querySelectorAll("[data-abdel]").forEach(b => b.onclick = () => { if (b.dataset.abdel === editando) formAbono(null); accion(b, () => quitarAbonos([b.dataset.abdel], "Quitar abono")) });
  $("abTabla").querySelectorAll("[data-abed]").forEach(b => b.onclick = () => formAbono(st.abonos.find(a => a.id === b.dataset.abed)));
  if (editando && !st.abonos.some(a => a.id === editando)) { formAbono(null); toast("El abono que editabas ya no está pendiente") }
  const selV = vis.filter(a => a.sel);
  $("abChkTodos").checked = vis.length > 0 && selV.length === vis.length;
  $("abChkTodos").indeterminate = selV.length > 0 && selV.length < vis.length;
  $("abSelInfo").textContent = vis.length ? `${selV.length} de ${vis.length} marcados para pagar, por ${money(selV.reduce((t, a) => t + (a.monto || 0), 0))}.` : "";

  // Revisión por fuente
  const fs = fuentesActivas(), all = fs.map(construir);
  if (!fs.includes(prefs.abCur)) prefs.abCur = fs[0] || fuentes[0];
  $("abFuentes").innerHTML = all.length ? all.map(r => `<tr data-abf="${esc(r.fuente)}" class="${r.fuente === prefs.abCur ? "cur" : ""}" tabindex="0"><td><b>${esc(r.fuente)}</b></td><td class="num">${r.nBen}</td><td class="num">${r.nDocs}</td><td class="num">${money(r.total)}</td><td>${r.errs ? `<span class="tag err">${r.errs} errores</span>` : r.warns ? `<span class="tag wrn">lista, ${r.warns} avisos</span>` : `<span class="tag okk">lista</span>`}</td></tr>`).join("")
    : `<tr><td colspan="5" class="empty">No hay abonos marcados para pagar.</td></tr>`;
  $("abFuentes").querySelectorAll("tr[data-abf]").forEach(tr => { const pick = () => { prefs.abCur = tr.dataset.abf; guardarPrefs(); prefijoEditado = false; renderAbonos() }; tr.onclick = pick; tr.onkeydown = e => { if (e.key === "Enter") pick() } });
  const r = all.find(x => x.fuente === prefs.abCur) || construir(prefs.abCur); current = r;
  $("abTituloNomina").textContent = "Nómina " + r.fuente + (r.nDocs ? " · " + conceptoDe(r).toLowerCase() : "");
  $("abTotal").textContent = money(r.total); $("abPagos").textContent = r.nBen; $("abCant").textContent = r.nDocs;
  const ul = $("abIssues");
  if (!r.nDocs) ul.innerHTML = `<li class="warn">No hay abonos marcados en esta fuente.</li>`;
  else if (!r.issues.length) ul.innerHTML = `<li class="ok" style="list-style:none">Todo cuadra con el instructivo de la planilla de 7 columnas. El archivo está listo para subir.</li>`;
  else ul.innerHTML = r.issues.sort((a, b) => a.lvl === b.lvl ? 0 : a.lvl === "error" ? -1 : 1).map(i => `<li class="${i.lvl}"><b>${esc(i.where)}:</b> ${esc(i.msg)}</li>`).join("");
  if (!prefijoEditado && document.activeElement !== $("abPrefijo")) $("abPrefijo").value = r.nDocs ? prefijoSugerido(r) : today() + "_REMUNERACIONES";
  const blocked = r.errs > 0 || !r.lines.length || !!st.abonosError;
  $("abBtnGenerar").disabled = blocked; $("abBtnBorrador").disabled = blocked;
  $("abBtnGenerar").textContent = blocked ? "Generar nómina y registrar en bitácora" : `Generar nómina N° ${st.nextNum} (${r.fuente}) y registrar`;
  $("abArchivoInfo").textContent = r.nDocs ? "Archivo: " + nombreArchivo(r) + ".txt" : "";
  $("abPrevTxt").innerHTML = r.lines.length ? r.lines.map(l => `<span class="ln r1">${l.f.map(esc).join('<span class="t">⇥</span>')}</span>`).join("") : `<span class="ln r2">(vacío)</span>`;
  previewPlanilla(r.lines);
  return r;
}

// Vista previa con el encabezado de la planilla Solo Abonos DET.
function previewPlanilla(lines) {
  const H = ["RUT", "NOMBRES Y APELLIDOS O RAZÓN SOCIAL", "EMAIL", "BANCO", "FORMA DE PAGO", "Nº DE CUENTA", "MONTO DEL PAGO"];
  let h = `<table><tbody><tr class="logo"><td colspan="2"><img src="${LOGO}" alt="BancoEstado"></td><td class="ttl">Pago</td><td colspan="3"></td><td class="ver">Versión 1.1</td></tr>`;
  h += `<tr><td colspan="2"></td><td class="sub9">(7 Columnas)</td><td colspan="4"></td></tr>`;
  h += `<tr class="h">${H.map(t => `<td class="o1">${t}</td>`).join("")}</tr>`;
  lines.forEach(l => { const f = l.f; h += `<tr>${f.slice(0, 6).map(v => `<td>${esc(v)}</td>`).join("")}<td class="r">${esc(f[6])}</td></tr>` });
  $("abPrevPl").innerHTML = h + `</tbody></table>`;
}

export const contarAbonos = () => st.abonos.length ? st.abonos.filter(a => a.sel).length + "/" + st.abonos.length : "";
