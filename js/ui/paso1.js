// Paso 1: maestro de proveedores.

import { BANCOS, FORMAS, SECTORES, M_BANCO } from "../catalogos.js";
import { S, normRut, rutOk, fmtRut, checkProv, today } from "../formato.js";
import { ingest, parsePaste, readFile, prepararIngesta } from "../importar.js";
import { plantillaSimple } from "../excel.js";
import { st, guardarProveedor, eliminarProveedor, aplicarIngesta, suscribirHistorial, aFecha } from "../datos.js";
import { $, esc, fillSelect, toast, accion, descargar, prefs, go, mensajeError } from "./comun.js";
import { verPagosDe } from "./paso4.js";

let editing = null, bajaHist = null;

export function provForm(p) {
  editing = p ? p.rut : null;
  $("fRut").value = p ? p.rut : ""; $("fNombre").value = p ? p.nombre : ""; $("fEmail").value = p ? p.email : "";
  $("fBanco").value = p && p.banco ? p.banco : "012"; $("fForma").value = p && p.forma ? p.forma : "01";
  $("fCuenta").value = p ? p.cuenta : ""; $("fSector").value = p && p.sector ? p.sector : "64";
  $("provFormTitle").textContent = p ? "Editar proveedor " + fmtRut(p.rut) : "Agregar proveedor";
  // Cambiar el RUT borra el registro anterior: las reglas solo lo permiten a pAdmin().
  $("fRut").disabled = !!p && !st.admin;
  $("fRut").title = p && !st.admin ? "Solo un administrador puede cambiar el RUT" : "";
  $("btnDelProv").hidden = !p || !st.admin;
  $("btnPagosProv").hidden = !p;
  mostrarHistorial(p ? p.rut : null);
}

// Historial del proveedor: altas y cambios, con antes y después de los datos bancarios.
function mostrarHistorial(rut) {
  if (bajaHist) { bajaHist(); bajaHist = null }
  const box = $("provHist");
  if (!rut) { box.hidden = true; box.innerHTML = ""; return }
  box.hidden = false; box.innerHTML = `<p class="hint">Cargando historial…</p>`;
  bajaHist = suscribirHistorial("proveedor:" + rut, lista => {
    const campos = o => o ? Object.entries(o).filter(([k]) => k !== "rut").map(([k, v]) => `${k}: ${esc(v) || "—"}`).join(" · ") : "";
    box.innerHTML = `<h3>Historial del proveedor</h3>` + (lista.length ? `<ul class="trace">${lista.slice().reverse().map(h => `<li><b>${esc(h.accion)}</b> <span class="hint">${fechaHora(h.createdAt)} · ${esc(h.autor)}</span><br>${esc(h.detalle)}${h.antes && h.despues ? `<span class="dochist">Antes: ${campos(h.antes)}</span><span class="hint" style="display:block">Después: ${campos(h.despues)}</span>` : ""}</li>`).join("")}</ul>` : `<p class="hint">Sin movimientos registrados.</p>`);
  });
}
export function fechaHora(t) { const d = aFecha(t); return d ? d.toLocaleString("es-CL", { dateStyle: "short", timeStyle: "short" }) : "" }

// Ingiere filas pegadas o importadas y las guarda en Firestore.
export async function ingestar(r, origen) {
  const prep = prepararIngesta(r, { maestro: st.maestro, fuentes: st.config.fuentes, defFuente: prefs.defFuente, pendientes: st.docs });
  if (!prep.provs.length && !prep.docs.length && !prep.rechazados.length && !prep.corregir.length && !prep.repetidos) { toast("No se reconocieron filas. Revisa el orden de las columnas."); return false }
  await aplicarIngesta(prep, origen); // los proveedores sin cambios no se escriben
  const parts = []; if (prep.nNew) parts.push(prep.nNew + " proveedores nuevos"); if (prep.nUpd) parts.push(prep.nUpd + " actualizados");
  if (prep.docs.length) parts.push(prep.docs.length + " documentos (" + Object.entries(prep.byF).map(([f, n]) => f + " " + n).join(", ") + ")");
  if (prep.nuevasFuentes.length) parts.push("fuente nueva: " + prep.nuevasFuentes.join(", "));
  let msg = parts.length ? "Agregado: " + parts.join("; ") : "";
  const mas = [];
  if (prep.corregir.length) mas.push(`${prep.corregir.length} pendiente${prep.corregir.length > 1 ? "s" : ""} con el tipo de documento corregido`);
  if (prep.repetidos) mas.push(`${prep.repetidos} ya estaba${prep.repetidos > 1 ? "n" : ""} pendiente${prep.repetidos > 1 ? "s" : ""} y no se duplic${prep.repetidos > 1 ? "aron" : "ó"}`);
  if (prep.sinTipo) mas.push(`${prep.sinTipo} sin tipo de documento reconocido: corrígelo con Editar`);
  if (prep.sinCuenta) mas.push(`${prep.sinCuenta} proveedor${prep.sinCuenta > 1 ? "es" : ""} nuevo${prep.sinCuenta > 1 ? "s" : ""} sin N° de cuenta: complétalo en Proveedores`);
  if (mas.length) msg += (msg ? ". " : "") + mas.join(". ");
  if (prep.rechazados.length) msg += (msg ? ". " : "") + `${prep.rechazados.length} documento${prep.rechazados.length > 1 ? "s" : ""} sin monto válido no se agregó (N° ${prep.rechazados.slice(0, 5).map(d => d.ndoc || "s/n").join(", ")}${prep.rechazados.length > 5 ? "…" : ""})`;
  toast(msg || "No hubo cambios");
  return true;
}
export async function importarArchivo(e) {
  const file = e.target.files[0]; if (!file) return;
  try { const r = await readFile(file, st.config.fuentes); await ingestar(r, file.name) }
  catch (err) { toast("No se pudo leer el archivo: " + mensajeError(err)) }
  e.target.value = "";
}

export function init() {
  fillSelect($("fBanco"), BANCOS); fillSelect($("fForma"), FORMAS); fillSelect($("fSector"), SECTORES);
  $("fSector").value = "64";
  $("btnClearProv").onclick = () => provForm(null);
  $("btnPagosProv").onclick = () => { if (editing) verPagosDe(editing) };
  $("btnCtaRut").onclick = () => { const r = normRut($("fRut").value); if (!r) { toast("Escribe primero el RUT"); return } $("fCuenta").value = r.slice(0, -1); $("fBanco").value = "012"; $("fForma").value = "01" };
  $("btnSaveProv").onclick = () => accion($("btnSaveProv"), async () => {
    const raw = { rut: $("fRut").value, nombre: $("fNombre").value, email: $("fEmail").value, banco: $("fBanco").value, forma: $("fForma").value, cuenta: $("fCuenta").value, sector: $("fSector").value };
    const c = checkProv(raw, st.config.emailDefecto);
    if (c.e.length) { toast("No se guardó: " + c.e[0]); return }
    const ed = editing;
    const r = await guardarProveedor({ ...c.out, email: S(raw.email) }, ed);
    if (editing === ed) provForm(null); // si mientras tanto se abrió otro proveedor, no se toca
    toast((r === "sin cambios" ? "Sin cambios" : "Proveedor guardado") + (c.w.length ? ". Ojo: " + c.w[0] : ""));
  });
  $("btnDelProv").onclick = () => { if (editing && confirm("¿Eliminar a " + fmtRut(editing) + " del maestro?")) accion($("btnDelProv"), async () => { await eliminarProveedor(editing); provForm(null); toast("Proveedor eliminado") }) };
  $("btnPasteProv").onclick = () => accion($("btnPasteProv"), async () => { if (await ingestar(ingest(parsePaste($("pasteProv").value)), "pegado paso 1")) $("pasteProv").value = "" });
  $("fileProv").addEventListener("change", importarArchivo);
  $("search").oninput = renderProv;
  $("btnExportMaestro").onclick = () => {
    const list = Object.values(st.maestro); if (!list.length) { toast("El maestro está vacío"); return }
    const q = v => /[;"\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    const csv = "RUT;NOMBRE;EMAIL;BANCO;FORMA DE PAGO;N CUENTA;SECTOR\r\n" + list.map(p => [p.rut, p.nombre, p.email, p.banco, p.forma, p.cuenta, p.sector].map(v => q(S(v))).join(";")).join("\r\n");
    descargar("maestro_proveedores_" + today() + ".csv", "﻿" + csv);
  };
  $("btnTemplate").onclick = () => { try { descargar("plantilla_pago_proveedores.xlsx", plantillaSimple()) } catch (e) { toast(mensajeError(e)) } };
}

export function renderProv() {
  const maestro = st.maestro;
  const q = S($("search").value).toLowerCase(); const qr = normRut(q);
  const list = Object.values(maestro).filter(p => !q || S(p.nombre).toLowerCase().includes(q) || (qr && p.rut.includes(qr))).sort((a, b) => S(a.nombre).localeCompare(S(b.nombre)));
  $("tbProv").innerHTML = list.length ? list.map(p => {
    const c = checkProv(p, st.config.emailDefecto);
    return `<tr class="clickable" data-rut="${esc(p.rut)}" tabindex="0"><td class="mono ${rutOk(p.rut) ? "" : "bad"}">${esc(fmtRut(p.rut))}</td><td>${esc(p.nombre)}${c.e.length ? ` <span class="bad" title="${esc(c.e.join("; "))}">● revisar</span>` : ""}</td><td>${esc(p.banco)} ${esc((M_BANCO[p.banco] || "?").split(" /")[0])}</td><td class="mono">${esc(p.forma)}</td><td class="mono">${esc(p.cuenta)}</td><td class="mono">${esc(p.sector)}</td><td>${esc(p.email)}</td></tr>`
  }).join("")
    : `<tr><td colspan="7" class="empty">${Object.keys(maestro).length ? "Sin resultados para la búsqueda." : "Todavía no hay proveedores. Importa una planilla de pago anterior para cargarlos de una vez."}</td></tr>`;
  $("tbProv").querySelectorAll("tr[data-rut]").forEach(tr => { const open = () => { provForm(maestro[tr.dataset.rut]); window.scrollTo({ top: 0, behavior: "smooth" }) }; tr.onclick = open; tr.onkeydown = e => { if (e.key === "Enter") open() } });
  $("dlRut").innerHTML = Object.values(maestro).map(p => `<option value="${esc(p.rut)}">${esc(p.nombre)}</option>`).join("");
}

// Llamado desde el paso 2: abre el formulario con un RUT que falta en el maestro.
export function nuevoConRut(rut) { provForm(null); $("fRut").value = rut; go(1); $("fNombre").focus() }
