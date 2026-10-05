// Lectura y escritura en Firestore. Colecciones con prefijo pago_.
// Mantiene el estado compartido (st) al día con onSnapshot y concentra
// todas las escrituras, cada una firmada y con su entrada de historial.

import { db, fs, firma } from "./firebase.js";
import { FUENTES_DEFECTO, EMAIL_DEFECTO, PREFIJO_DEFECTO } from "./catalogos.js";
import { S, checkProv, checkAbono, money, fmtRut, fmtISO, todayISO, normDc, esCobroCaja, noCobrado, tipoDe, conDocumentos, conAbonos } from "./formato.js";

const { doc, collection, onSnapshot, query, where, runTransaction, writeBatch, serverTimestamp, Timestamp, getDoc, deleteDoc } = fs;

const C = { config: "pago_config", prov: "pago_proveedores", docs: "pago_documentos", abonos: "pago_abonos", nom: "pago_nominas", hist: "pago_historial" };
const refGeneral = () => doc(db, C.config, "general");
const refContador = () => doc(db, C.config, "contador");

// ---------- estado compartido ----------
export const st = {
  email: "", admin: false,
  maestro: {}, docs: [], nominas: [], abonos: [], abonosError: null,
  config: { fuentes: [...FUENTES_DEFECTO], emailDefecto: EMAIL_DEFECTO, feriados: [], prefijoArchivo: PREFIJO_DEFECTO, cuentas: [] },
  contadorExiste: false, nextNum: 1,
  listo: { prov: false, docs: false, nom: false, general: false, contador: false, abonos: false },
  error: null
};
const oyentes = new Set();
export const alCambiar = fn => { oyentes.add(fn); return () => oyentes.delete(fn) };
let pendiente = false;
function avisar() { if (pendiente) return; pendiente = true; queueMicrotask(() => { pendiente = false; oyentes.forEach(f => f()) }) }
export const todoListo = () => Object.values(st.listo).every(Boolean);

// Los serverTimestamp pendientes se ven con la hora estimada.
const datos = s => s.data({ serverTimestamps: "estimate" });
export const aFecha = t => t && typeof t.toDate === "function" ? t.toDate() : t ? new Date(t) : null;

// Id de documento pendiente que ordena por fecha de ingreso (Firestore
// entrega la colección ordenada por id). Así la nómina respeta el orden de
// carga, igual que la lista del panel de referencia.
let seq = 0;
export const nuevoIdDoc = () => Date.now().toString(36).padStart(9, "0") + "-" + (seq++ % 1679616).toString(36).padStart(4, "0") + Math.random().toString(36).slice(2, 6);

// ---------- acceso ----------
// pAllowed(): poder leer pago_config/general. pAdmin(): las reglas solo dejan
// borrar proveedores a pAdmin(), así que se prueba borrar un id que nunca es
// un RUT (no existe, no cambia nada). La lista de correos vive solo en las reglas.
export async function verificarAcceso(email) {
  st.email = email;
  try { await getDoc(refGeneral()) }
  catch (e) { if (e.code === "permission-denied") return false; throw e }
  try { await deleteDoc(doc(db, C.prov, "SONDA-ADMIN")); st.admin = true } catch (e) { st.admin = false }
  return true;
}

// ---------- suscripciones ----------
let bajas = [];
export function suscribir() {
  desuscribir();
  const err = e => { st.error = e; avisar() };
  bajas.push(onSnapshot(collection(db, C.prov), qs => {
    const m = {}; qs.forEach(s => { m[s.id] = { ...datos(s), rut: s.id } }); st.maestro = m; st.listo.prov = true; avisar();
  }, err));
  bajas.push(onSnapshot(collection(db, C.docs), qs => {
    st.docs = qs.docs.map(s => ({ ...datos(s), id: s.id })); st.listo.docs = true; avisar();
  }, err));
  // Abonos (remuneraciones): si las reglas nuevas aún no se publican, la
  // lectura se rechaza; eso no debe cerrar el resto del panel.
  bajas.push(onSnapshot(collection(db, C.abonos), qs => {
    st.abonos = qs.docs.map(s => ({ ...datos(s), id: s.id })); st.abonosError = null; st.listo.abonos = true; avisar();
  }, e => { st.abonos = []; st.abonosError = e; st.listo.abonos = true; avisar() }));
  bajas.push(onSnapshot(collection(db, C.nom), qs => {
    st.nominas = qs.docs.map(s => ({ ...datos(s), id: s.id })).sort((a, b) => a.num - b.num); st.listo.nom = true; avisar();
  }, err));
  bajas.push(onSnapshot(refGeneral(), s => {
    const d = s.exists() ? datos(s) : {};
    st.config = {
      fuentes: Array.isArray(d.fuentes) && d.fuentes.length ? d.fuentes : [...FUENTES_DEFECTO],
      emailDefecto: d.emailDefecto != null ? d.emailDefecto : EMAIL_DEFECTO,
      feriados: Array.isArray(d.feriados) ? d.feriados : [],
      prefijoArchivo: d.prefijoArchivo || PREFIJO_DEFECTO,
      // Cuentas de origen de las transferencias: [{ cuenta, nombre, fuente }]
      cuentas: Array.isArray(d.cuentas) ? d.cuentas.filter(c => c && c.cuenta) : []
    };
    st.listo.general = true; avisar();
  }, err));
  bajas.push(onSnapshot(refContador(), s => {
    st.contadorExiste = s.exists(); st.nextNum = s.exists() ? s.data().nextNum : 1; st.listo.contador = true; avisar();
  }, err));
}
export function desuscribir() {
  bajas.forEach(f => f()); bajas = [];
  Object.keys(st.listo).forEach(k => st.listo[k] = false);
  st.maestro = {}; st.docs = []; st.nominas = []; st.abonos = []; st.abonosError = null; st.error = null;
}

// Historial de una referencia ("nomina:12", "proveedor:761234560").
export function suscribirHistorial(ref, cb) {
  return onSnapshot(query(collection(db, C.hist), where("ref", "==", ref)), qs => {
    cb(qs.docs.map(s => ({ ...datos(s), id: s.id })).sort((a, b) => (aFecha(a.createdAt) || 0) - (aFecha(b.createdAt) || 0)));
  }, () => cb([]));
}

// ---------- helpers de escritura ----------
const f = () => firma(st.email);
const hist = (accion, ref, detalle, antes = null, despues = null) => ({ accion, ref, detalle, antes, despues, autor: st.email, createdAt: serverTimestamp() });
const refHist = () => doc(collection(db, C.hist));
const refDoc = id => doc(db, C.docs, id);
const refAbono = id => doc(db, C.abonos, id);

// Aplica operaciones (fn(batch)) en batches de hasta 400 escrituras.
async function enLotes(ops, alAvanzar) {
  for (let i = 0; i < ops.length; i += 400) {
    const b = writeBatch(db);
    ops.slice(i, i + 400).forEach(op => op(b));
    await b.commit();
    if (alAvanzar) alAvanzar(Math.min(i + 400, ops.length), ops.length);
  }
}

const configCompleta = parcial => ({ ...st.config, ...parcial });
// Las cuentas de origen solo se escriben si hay alguna: así la configuración se
// sigue guardando aunque las reglas que las permiten aún no estén publicadas.
const datosConfig = c => ({ fuentes: c.fuentes, emailDefecto: c.emailDefecto, feriados: c.feriados, prefijoArchivo: c.prefijoArchivo, ...(c.cuentas && c.cuentas.length ? { cuentas: c.cuentas } : {}), ...f() });
export async function guardarConfig(parcial) {
  await fs.setDoc(refGeneral(), datosConfig(configCompleta(parcial)));
}
const opConfig = parcial => b => { b.set(refGeneral(), datosConfig(configCompleta(parcial))) };

// ---------- proveedores ----------
const CAMPOS_PROV = ["nombre", "email", "banco", "forma", "cuenta", "sector"];
const BANCARIOS = ["banco", "forma", "cuenta"];
const soloProv = p => ({ rut: p.rut, nombre: p.nombre, email: p.email, banco: p.banco, forma: p.forma, cuenta: p.cuenta, sector: p.sector });

// Entrada de historial de un alta o edición. Cuando cambia banco, cuenta o
// forma de pago guarda antes y después completos: es el control contra fraude.
function histProveedor(antes, despues, origen) {
  const ref = "proveedor:" + despues.rut;
  if (!antes) return hist("alta proveedor", ref, `${fmtRut(despues.rut)} ${despues.nombre}${origen ? " (" + origen + ")" : ""}`, null, soloProv(despues));
  const cambios = CAMPOS_PROV.filter(k => S(antes[k]) !== S(despues[k]));
  if (!cambios.length) return null;
  const bancario = cambios.some(k => BANCARIOS.includes(k));
  const sub = o => Object.fromEntries(cambios.map(k => [k, S(o[k])]));
  return hist(bancario ? "cambio datos bancarios proveedor" : "editar proveedor", ref,
    `${fmtRut(despues.rut)} ${despues.nombre}: cambia ${cambios.join(", ")}${origen ? " (" + origen + ")" : ""}`,
    bancario ? soloProv(antes) : sub(antes), bancario ? soloProv(despues) : sub(despues));
}
function opsProveedor(antes, despues, origen) {
  const h = histProveedor(antes, despues, origen);
  if (antes && !h) return [];
  const ref = doc(db, C.prov, despues.rut);
  const data = { ...soloProv(despues), ...f() };
  return [
    b => antes ? b.set(ref, data, { merge: true }) : b.set(ref, { ...data, createdAt: serverTimestamp(), createdBy: st.email }),
    b => b.set(refHist(), h)
  ];
}

// rec: proveedor ya validado. editando: RUT que se abrió en el formulario.
export async function guardarProveedor(rec, editando) {
  if (editando && editando !== rec.rut) {
    if (!st.admin) throw new Error("solo un administrador puede cambiar el RUT de un proveedor");
    const old = st.maestro[editando];
    const b = writeBatch(db);
    b.set(doc(db, C.prov, rec.rut), { ...soloProv(rec), createdAt: old.createdAt || serverTimestamp(), createdBy: old.createdBy || st.email, ...f() });
    b.delete(doc(db, C.prov, editando));
    b.set(refHist(), hist("cambiar RUT proveedor", "proveedor:" + rec.rut, `${fmtRut(editando)} pasa a ${fmtRut(rec.rut)}`, soloProv(old), soloProv(rec)));
    b.set(refHist(), hist("cambiar RUT proveedor", "proveedor:" + editando, `${fmtRut(editando)} pasa a ${fmtRut(rec.rut)}`, soloProv(old), soloProv(rec)));
    return b.commit();
  }
  const ops = opsProveedor(st.maestro[rec.rut] || null, rec, "");
  if (!ops.length) return "sin cambios";
  return enLotes(ops);
}
export async function eliminarProveedor(rut) {
  const old = st.maestro[rut]; const b = writeBatch(db);
  b.delete(doc(db, C.prov, rut));
  b.set(refHist(), hist("eliminar proveedor", "proveedor:" + rut, `${fmtRut(rut)} ${old ? old.nombre : ""}`, old ? soloProv(old) : null, null));
  return b.commit();
}

// ---------- ingestión (resultado de importar.prepararIngesta) ----------
export async function aplicarIngesta(prep, origen, alAvanzar) {
  const ops = [];
  prep.provs.forEach(({ antes, despues }) => ops.push(...opsProveedor(antes, despues, origen)));
  prep.docs.forEach(d => ops.push(b => b.set(refDoc(nuevoIdDoc()), { ...d, createdAt: serverTimestamp(), createdBy: st.email, ...f() })));
  if (prep.nuevasFuentes.length) ops.push(opConfig({ fuentes: prep.fuentes }));
  if (prep.docs.length) ops.push(b => b.set(refHist(), hist("agregar documentos", "documentos", `${prep.docs.length} documentos (${Object.entries(prep.byF).map(([k, n]) => k + " " + n).join(", ")})${origen ? " desde " + origen : ""}`)));
  // Pendientes que ya estaban, con el tipo de documento vacío o inválido: se completa.
  (prep.corregir || []).forEach(c => ops.push(b => b.update(refDoc(c.id), { tipo: c.tipo, ...f() })));
  if ((prep.corregir || []).length) ops.push(b => b.set(refHist(), hist("corregir tipo de documento", "documentos", `${prep.corregir.length} documento${prep.corregir.length > 1 ? "s" : ""} pendiente${prep.corregir.length > 1 ? "s" : ""} sin tipo válido${origen ? ", desde " + origen : ""}: ${prep.corregir.slice(0, 20).map(c => `${c.ndoc} → ${c.tipo}`).join(", ")}${prep.corregir.length > 20 ? "…" : ""}`, { tipos: prep.corregir.map(c => c.antes || "vacío").join(", ") }, { tipos: prep.corregir.map(c => c.tipo).join(", ") })));
  await enLotes(ops, alAvanzar);
}

// ---------- documentos pendientes ----------
export async function agregarDoc(d) {
  const b = writeBatch(db);
  b.set(refDoc(nuevoIdDoc()), { ...d, createdAt: serverTimestamp(), createdBy: st.email, ...f() });
  return b.commit();
}
// Edita un documento pendiente: guarda solo lo que cambia y lo deja en el historial.
const CAMPOS_DOC = ["rut", "fecha", "monto", "ndoc", "tipo", "fuente", "dc"];
export async function editarDoc(id, nuevo) {
  const antes = st.docs.find(d => d.id === id);
  if (!antes) throw new Conflicto("El documento ya no está pendiente (otro usuario lo movió o lo incluyó en una nómina)");
  const cambios = CAMPOS_DOC.filter(k => S(antes[k]) !== S(nuevo[k]));
  if (!cambios.length) return "sin cambios";
  const sub = o => Object.fromEntries(cambios.map(k => [k, k === "monto" ? o[k] : S(o[k])]));
  const b = writeBatch(db);
  b.update(refDoc(id), { ...Object.fromEntries(cambios.map(k => [k, nuevo[k] ?? ""])), ...f() });
  b.set(refHist(), hist("editar documento pendiente", "documentos", `Doc ${S(nuevo.ndoc)} de ${fmtRut(nuevo.rut)} (${money(nuevo.monto)}): cambia ${cambios.join(", ")}`, sub(antes), sub(nuevo)));
  return b.commit();
}
export const actualizarDocs = (ids, cambios) => enLotes(ids.map(id => b => b.update(refDoc(id), { ...cambios, ...f() })));
const resumenDoc = d => ({ rut: d.rut, fecha: d.fecha, monto: d.monto, ndoc: d.ndoc, tipo: d.tipo, fuente: d.fuente, dc: d.dc || "" });
export async function quitarDocs(ids, motivo) {
  const porId = Object.fromEntries(st.docs.map(d => [d.id, d]));
  const ops = [];
  for (let i = 0; i < ids.length; i += 300) {
    const tramo = ids.slice(i, i + 300);
    tramo.forEach(id => ops.push(b => b.delete(refDoc(id))));
    const lista = tramo.map(id => porId[id]).filter(Boolean);
    ops.push(b => b.set(refHist(), hist("borrar documentos pendientes", "documentos", `${motivo}: ${lista.length} documentos por ${money(lista.reduce((s, d) => s + (d.monto || 0), 0))}`, { documentos: lista.map(resumenDoc) }, null)));
  }
  return enLotes(ops);
}

// ---------- abonos pendientes (remuneraciones) ----------
const resumenAbono = a => ({ rut: a.rut, nombre: a.nombre, monto: a.monto, fuente: a.fuente, concepto: a.concepto || "", cuenta: a.cuenta, banco: a.banco, forma: a.forma });
export async function agregarAbonos(prep, origen) {
  const ops = prep.abonos.map(a => b => b.set(refAbono(nuevoIdDoc()), { ...a, createdAt: serverTimestamp(), createdBy: st.email, ...f() }));
  if (prep.nuevasFuentes.length) ops.push(opConfig({ fuentes: prep.fuentes }));
  if (prep.abonos.length) ops.push(b => b.set(refHist(), hist("agregar abonos", "abonos", `${prep.abonos.length} abonos por ${money(prep.abonos.reduce((t, a) => t + a.monto, 0))} (${Object.entries(prep.byF).map(([k, n]) => k + " " + n).join(", ")})${origen ? " desde " + origen : ""}`)));
  // Abonos pendientes con banco o forma inválidos (importados antes en texto): se corrigen
  // con los datos del archivo, y el historial guarda el antes y el después completos.
  (prep.corregir || []).forEach(({ id, antes, despues }) => {
    const cambios = CAMPOS_ABONO.filter(k => S(antes[k]) !== S(despues[k]));
    if (!cambios.length) return;
    const sub = o => Object.fromEntries(CAMPOS_ABONO.map(k => [k, k === "monto" ? o[k] : S(o[k])]));
    ops.push(b => b.update(refAbono(id), { ...Object.fromEntries(cambios.map(k => [k, despues[k] ?? ""])), ...f() }));
    ops.push(b => b.set(refHist(), hist("cambio datos bancarios abono", "abonos", `${fmtRut(despues.rut)} ${despues.nombre} (${money(despues.monto)}): corregido al importar${origen ? " " + origen : ""}; cambia ${cambios.join(", ")}`, sub(antes), sub(despues))));
  });
  await enLotes(ops);
}
// Edita un abono pendiente. Si cambian los datos bancarios, el historial
// guarda el antes y el después completos (control contra fraude).
const CAMPOS_ABONO = ["rut", "nombre", "email", "banco", "forma", "cuenta", "monto", "fuente", "concepto", "glosa"];
export async function editarAbono(id, nuevo) {
  const antes = st.abonos.find(a => a.id === id);
  if (!antes) throw new Conflicto("El abono ya no está pendiente (otro usuario lo movió o lo incluyó en una nómina)");
  const cambios = CAMPOS_ABONO.filter(k => S(antes[k]) !== S(nuevo[k]));
  if (!cambios.length) return "sin cambios";
  const bancario = cambios.some(k => ["rut", "banco", "forma", "cuenta"].includes(k));
  const sub = (o, ks) => Object.fromEntries(ks.map(k => [k, k === "monto" ? o[k] : S(o[k])]));
  const b = writeBatch(db);
  b.update(refAbono(id), { ...Object.fromEntries(cambios.map(k => [k, nuevo[k] ?? ""])), ...f() });
  b.set(refHist(), hist(bancario ? "cambio datos bancarios abono" : "editar abono", "abonos", `${fmtRut(nuevo.rut)} ${nuevo.nombre} (${money(nuevo.monto)}): cambia ${cambios.join(", ")}`,
    sub(antes, bancario ? CAMPOS_ABONO : cambios), sub(nuevo, bancario ? CAMPOS_ABONO : cambios)));
  return b.commit();
}
export const actualizarAbonos = (ids, cambios) => enLotes(ids.map(id => b => b.update(refAbono(id), { ...cambios, ...f() })));
export async function quitarAbonos(ids, motivo) {
  const porId = Object.fromEntries(st.abonos.map(a => [a.id, a]));
  const ops = [];
  for (let i = 0; i < ids.length; i += 300) {
    const tramo = ids.slice(i, i + 300);
    tramo.forEach(id => ops.push(b => b.delete(refAbono(id))));
    const lista = tramo.map(id => porId[id]).filter(Boolean);
    ops.push(b => b.set(refHist(), hist("borrar abonos pendientes", "abonos", `${motivo}: ${lista.length} abonos por ${money(lista.reduce((t, a) => t + (a.monto || 0), 0))}`, { abonos: lista.map(resumenAbono) }, null)));
  }
  return enLotes(ops);
}

// ---------- nóminas ----------
export class Conflicto extends Error { }

// Genera la nómina en una sola transacción: reserva el número, verifica que
// los documentos sigan pendientes y marcados y que los datos bancarios no
// hayan cambiado, crea la nómina, borra los documentos y registra el historial.
//
// Si otro usuario genera al mismo tiempo, Firestore evalúa la regla del
// contador (nextNum == anterior + 1) contra el número ya reservado por la
// otra transacción y rechaza con permission-denied en vez de reintentar.
// Por eso un rechazo se reintenta unas veces con espera creciente: si era
// un choque, el reintento toma el número siguiente; si era un rechazo real
// (sin permiso, datos inválidos), vuelve a fallar y se informa.
export const generarNomina = (r, archivo) => conReintento(al => transaccionGenerar(r, archivo, al));
async function conReintento(transaccion) {
  for (let intento = 0; ; intento++) {
    let usado = null;
    try { return await transaccion(n => { usado = n }) }
    catch (e) {
      if (e.code !== "permission-denied" || usado == null || intento >= 5) throw e;
      await new Promise(ok => setTimeout(ok, 250 * (intento + 1) + Math.random() * 400));
    }
  }
}
function transaccionGenerar(r, archivo, alReservar) {
  return runTransaction(db, async tx => {
    const cSnap = await tx.get(refContador());
    const num = cSnap.exists() ? cSnap.data().nextNum : 1;
    alReservar(num);
    const nRef = doc(db, C.nom, String(num));
    const [nSnap, dSnaps, pSnaps] = await Promise.all([
      tx.get(nRef),
      Promise.all(r.ids.map(id => tx.get(refDoc(id)))),
      Promise.all(r.groups.map(g => tx.get(doc(db, C.prov, g.p.rut))))
    ]);
    if (nSnap.exists()) throw new Conflicto(`La nómina N° ${num} ya existe. Recarga la página e inténtalo de nuevo.`);
    const movidos = dSnaps.filter(s => !s.exists() || !s.data().sel || s.data().fuente !== r.fuente).length;
    if (movidos) throw new Conflicto(`${movidos} documento${movidos > 1 ? "s" : ""} de ${r.fuente} ya no ${movidos > 1 ? "están" : "está"} pendiente${movidos > 1 ? "s" : ""} o marcado${movidos > 1 ? "s" : ""} (otro usuario ${movidos > 1 ? "los" : "lo"} movió, quitó o incluyó en otra nómina). No se generó la nómina; revisa la lista y vuelve a intentarlo.`);
    r.groups.forEach((g, i) => {
      const s = pSnaps[i];
      const ahora = s.exists() ? checkProv(s.data(), st.config.emailDefecto).out : null;
      if (!ahora || ["nombre", "email", "banco", "forma", "cuenta", "sector"].some(k => ahora[k] !== g.p[k]))
        throw new Conflicto(`Los datos del proveedor ${fmtRut(g.p.rut)} cambiaron mientras revisabas. No se generó la nómina; revisa el paso 3 y vuelve a intentarlo.`);
    });
    const nomina = {
      num, fuente: r.fuente, archivo, estado: "generada",
      creadaAt: serverTimestamp(), creadaPor: st.email,
      fechaCarga: "", fechaPago: "", operacion: "", obs: "", total: r.total,
      lineas: r.lines.map(l => ({ tipo: l.tipo, f: [...l.f] })),
      pagos: r.groups.map(g => ({ rut: g.p.rut, nombre: g.p.nombre, banco: g.p.banco, cuenta: g.p.cuenta, monto: g.sum, estado: "pendiente", motivo: "", reint: "", docs: g.docs.map(d => ({ docId: d.id, fecha: d.fecha, monto: d.monto, ndoc: d.ndoc, tipo: d.tipo, dc: d.dc || "" })) })),
      ...f()
    };
    if (cSnap.exists()) tx.update(refContador(), { nextNum: num + 1, ...f() });
    else tx.set(refContador(), { nextNum: num + 1, ...f() });
    tx.set(nRef, nomina);
    r.ids.forEach(id => tx.delete(refDoc(id)));
    tx.set(refHist(), hist("generar nómina", "nomina:" + num, `N° ${num} ${r.fuente}: ${r.nBen} pagos, ${r.nDocs} documentos, total ${money(r.total)}. Archivo ${archivo}.txt`, null, { archivo, total: r.total, pagos: r.nBen, documentos: r.nDocs }));
    return nomina;
  });
}

// Nómina de remuneraciones y abonos (7 columnas): misma transacción y mismo
// correlativo que proveedores; verifica que cada abono siga pendiente,
// marcado y con los mismos datos bancarios y monto que se revisaron.
export const generarNominaAbonos = (r, archivo, concepto) => conReintento(al => runTransaction(db, async tx => {
  const cSnap = await tx.get(refContador());
  const num = cSnap.exists() ? cSnap.data().nextNum : 1;
  al(num);
  const nRef = doc(db, C.nom, String(num));
  const [nSnap, aSnaps] = await Promise.all([tx.get(nRef), Promise.all(r.ids.map(id => tx.get(refAbono(id))))]);
  if (nSnap.exists()) throw new Conflicto(`La nómina N° ${num} ya existe. Recarga la página e inténtalo de nuevo.`);
  const porId = Object.fromEntries(r.groups.flatMap(g => g.docs.map(d => [d.id, g])));
  const movidos = aSnaps.filter((s, i) => {
    if (!s.exists() || !s.data().sel || s.data().fuente !== r.fuente) return true;
    const a = checkAbono(s.data(), st.config.emailDefecto).out, g = porId[r.ids[i]];
    return !g || ["rut", "nombre", "banco", "forma", "cuenta"].some(k => a[k] !== g.p[k]) || !g.docs.some(d => d.id === r.ids[i] && d.monto === a.monto);
  }).length;
  if (movidos) throw new Conflicto(`${movidos} abono${movidos > 1 ? "s" : ""} de ${r.fuente} cambió o ya no está pendiente (otro usuario lo movió, quitó o incluyó en otra nómina). No se generó la nómina; revisa la lista y vuelve a intentarlo.`);
  const nomina = {
    num, tipo: "abonos", concepto: S(concepto), fuente: r.fuente, archivo, estado: "generada",
    creadaAt: serverTimestamp(), creadaPor: st.email,
    fechaCarga: "", fechaPago: "", operacion: "", obs: "", total: r.total,
    lineas: r.lines.map(l => ({ tipo: l.tipo, f: [...l.f] })),
    pagos: r.groups.map(g => ({ rut: g.p.rut, nombre: g.p.nombre, email: g.p.email, banco: g.p.banco, forma: g.p.forma, cuenta: g.p.cuenta, monto: g.sum, estado: "pendiente", motivo: "", reint: "", docs: g.docs.map(d => ({ abonoId: d.id, monto: d.monto, concepto: d.concepto || "", glosa: d.glosa || "" })) })),
    ...f()
  };
  if (cSnap.exists()) tx.update(refContador(), { nextNum: num + 1, ...f() });
  else tx.set(refContador(), { nextNum: num + 1, ...f() });
  tx.set(nRef, nomina);
  r.ids.forEach(id => tx.delete(refAbono(id)));
  tx.set(refHist(), hist("generar nómina", "nomina:" + num, `N° ${num} remuneraciones ${S(concepto)} ${r.fuente}: ${r.nBen} pagos, total ${money(r.total)}. Archivo ${archivo}.txt`, null, { archivo, total: r.total, pagos: r.nBen, abonos: r.nDocs, tipo: "abonos" }));
  return nomina;
}));

// Modifica una nómina leyendo su estado actual dentro de una transacción.
// fn(n) devuelve { cambios, hist: [..], docs: [..documentos a devolver] }.
// Si fn devuelve `salida`, eso es lo que recibe quien llamó (lo usa la carga
// del reporte del banco para informar lo que no pudo aplicar); si no, la
// nómina tal como estaba antes del cambio.
async function modificarNomina(id, fn) {
  return runTransaction(db, async tx => {
    const ref = doc(db, C.nom, id); const s = await tx.get(ref);
    if (!s.exists()) throw new Conflicto("La nómina ya no existe");
    const n = s.data();
    if (n.estado === "anulada") throw new Conflicto(`La nómina N° ${n.num} está anulada y ya no se puede modificar`);
    const r = fn(n);
    tx.update(ref, { ...r.cambios, ...f() });
    (r.docs || []).forEach(d => tx.set(refDoc(nuevoIdDoc()), { ...d, createdAt: serverTimestamp(), createdBy: st.email, ...f() }));
    (r.abonos || []).forEach(a => tx.set(refAbono(nuevoIdDoc()), { ...a, createdAt: serverTimestamp(), createdBy: st.email, ...f() }));
    (r.hist || []).forEach(h => tx.set(refHist(), h));
    return r.salida !== undefined ? r.salida : n;
  });
}
// Abono que vuelve a pendientes (rechazo o nómina anulada), con sus datos bancarios.
const abonoDevuelto = (n, p, d, texto) => { const o = { rut: p.rut, nombre: p.nombre, email: p.email || "", banco: p.banco, forma: p.forma, cuenta: p.cuenta, monto: d.monto, fuente: n.fuente, concepto: d.concepto || n.concepto || "", sel: true, hist: texto }; if (d.glosa) o.glosa = d.glosa; return o };
// Devuelve los ítems de un pago al lugar que corresponde según el tipo de nómina.
const devolver = (n, pagos, texto) => {
  const out = { docs: [], abonos: [] };
  // Una transferencia sin documento ni abono del panel (pago suelto) no devuelve nada.
  pagos.forEach(p => p.docs.forEach(d => conAbonos(n) ? out.abonos.push(abonoDevuelto(n, p, d, texto)) : conDocumentos(n) ? out.docs.push(docDevuelto(n, p, d, texto)) : null));
  return out;
};
const docDevuelto = (n, p, d, texto) => { const o = { rut: p.rut, fecha: d.fecha, monto: d.monto, ndoc: d.ndoc, tipo: d.tipo, fuente: n.fuente, sel: true, hist: texto }; if (d.dc) o.dc = d.dc; return o };
const refN = n => "nomina:" + n.num;

export const cargarNomina = (id, datosCarga) => modificarNomina(id, n => {
  if (n.estado !== "generada") throw new Conflicto(`La nómina N° ${n.num} ya no está en estado generada`);
  // Quién cargó y cuándo: las reglas exigen que cargadaPor sea quien escribe.
  return { cambios: { estado: "cargada", ...datosCarga, cargadaPor: st.email, cargadaAt: serverTimestamp() }, hist: [hist("cargar nómina", refN(n), `Cargada en BancoEstado el ${fmtISO(datosCarga.fechaCarga)}, fecha de pago ${fmtISO(datosCarga.fechaPago)}${datosCarga.operacion ? ", N° nómina BancoEstado " + datosCarga.operacion : ""}${datosCarga.obs ? ". " + datosCarga.obs : ""}`, { estado: "generada" }, { estado: "cargada", ...datosCarga })] };
});
export const guardarCarga = (id, datosCarga) => modificarNomina(id, n => {
  if (n.estado !== "cargada") throw new Conflicto(`La nómina N° ${n.num} no está cargada`);
  const antes = { fechaCarga: n.fechaCarga, fechaPago: n.fechaPago || "", operacion: n.operacion, obs: n.obs };
  const cambiados = Object.keys(antes).filter(k => S(antes[k]) !== S(datosCarga[k]));
  if (!cambiados.length) return { cambios: {} };
  const nombres = { fechaCarga: "fecha de carga", fechaPago: "fecha de pago", operacion: "N° de nómina BancoEstado", obs: "observación" };
  return { cambios: datosCarga, hist: [hist("editar datos de carga", refN(n), "Cambia " + cambiados.map(k => nombres[k]).join(", ") + (cambiados.includes("fechaPago") ? `: pago el ${fmtISO(datosCarga.fechaPago)}` : ""), antes, datosCarga)] };
});
export const deshacerCarga = id => modificarNomina(id, n => {
  if (n.estado !== "cargada" || !n.pagos.every(p => p.estado === "pendiente")) throw new Conflicto("Solo se deshace la carga si ningún pago tiene resultado");
  return { cambios: { estado: "generada", fechaCarga: "", fechaPago: "", cargadaPor: "", cargadaAt: null }, hist: [hist("deshacer carga", refN(n), "Vuelve a estado generada", { estado: "cargada", fechaCarga: n.fechaCarga, fechaPago: n.fechaPago || "" }, { estado: "generada", fechaCarga: "", fechaPago: "" })] };
});
export const resultadoPago = (id, i, estado, motivo) => modificarNomina(id, n => {
  if (n.estado !== "cargada") throw new Conflicto("El resultado se registra con la nómina cargada");
  const pagos = n.pagos.map(p => ({ ...p })); const p = pagos[i];
  if (p.reint && estado !== "rechazado") throw new Conflicto("Este pago ya se reintegró a pendientes; no se puede cambiar");
  const antes = { estado: p.estado, motivo: p.motivo };
  p.estado = estado; p.motivo = estado === "rechazado" ? S(motivo) : "";
  if (antes.estado === p.estado && antes.motivo === p.motivo) return { cambios: {} };
  if (estado !== "pagado" && (p.cobro || p.cobroFecha)) { p.cobro = ""; p.cobroFecha = "" } // el cobro en banco solo aplica a un pago pagado
  return { cambios: { pagos }, hist: [hist("resultado de pago", refN(n), `${fmtRut(p.rut)} ${p.nombre} (${money(p.monto)}): ${antes.estado} → ${p.estado}${p.motivo ? ", motivo: " + p.motivo : ""}`, antes, { estado: p.estado, motivo: p.motivo })] };
});
export const pagarPendientes = id => modificarNomina(id, n => {
  if (n.estado !== "cargada") throw new Conflicto("La nómina no está cargada");
  const pend = n.pagos.filter(p => p.estado === "pendiente");
  const pagos = n.pagos.map(p => p.estado === "pendiente" ? { ...p, estado: "pagado" } : p);
  return { cambios: { pagos }, hist: [hist("resultado de pago", refN(n), `${pend.length} pagos pendientes marcados como pagados (${money(pend.reduce((s, p) => s + p.monto, 0))})`, { estado: "pendiente", pagos: pend.map(p => p.rut) }, { estado: "pagado" })] };
});
// Resultados leídos del reporte de BancoEstado, todos los de una nómina en una
// sola transacción. `resultados` viene de conciliar() y se vuelve a validar aquí
// contra la nómina recién leída: entre la vista previa y el botón Aplicar, otra
// persona pudo registrar un resultado o reintegrar un pago. Lo que ya no calce
// se omite y se informa; nunca se pisa lo que otro escribió.
export const aplicarResultadosBanco = (id, resultados, archivo) => modificarNomina(id, n => {
  if (n.estado !== "cargada") throw new Conflicto(`La nómina N° ${n.num} no está cargada`);
  const pagos = n.pagos.map(p => ({ ...p }));
  const hechos = [], omitidos = [];
  resultados.forEach(r => {
    const p = pagos.find(x => x.rut === r.rut && x.monto === r.monto);
    if (!p) { omitidos.push(`${fmtRut(r.rut)}: el pago ya no está en la nómina`); return }
    if (p.reint) { omitidos.push(`${fmtRut(r.rut)}: se reintegró a pendientes mientras revisabas`); return }
    const motivo = r.estado === "rechazado" ? S(r.motivo) : "";
    if (p.estado === r.estado && S(p.motivo) === motivo) return;          // ya estaba así
    if (p.estado !== "pendiente") { omitidos.push(`${fmtRut(r.rut)}: otro usuario ya lo registró con otro resultado`); return }
    const antes = { estado: p.estado, motivo: p.motivo };
    p.estado = r.estado; p.motivo = motivo;
    // El cobro en banco solo existe para un pago cash o vale vista pagado.
    if (r.estado !== "pagado" && (p.cobro || p.cobroFecha)) { p.cobro = ""; p.cobroFecha = "" }
    hechos.push({ p, antes });
  });
  if (!hechos.length) return { cambios: {}, salida: { aplicados: 0, omitidos } };
  const pgd = hechos.filter(h => h.p.estado === "pagado"), rch = hechos.filter(h => h.p.estado === "rechazado");
  const suma = l => money(l.reduce((s, h) => s + h.p.monto, 0));
  const resumen = [pgd.length ? `${pgd.length} pagado${pgd.length > 1 ? "s" : ""} (${suma(pgd)})` : "",
                   rch.length ? `${rch.length} rechazado${rch.length > 1 ? "s" : ""} (${suma(rch)})` : ""].filter(Boolean).join(", ");
  return {
    cambios: { pagos }, salida: { aplicados: hechos.length, omitidos },
    hist: [
      hist("resultado del banco", refN(n), `Del reporte de BancoEstado${archivo ? ", archivo " + archivo : ""}: ${resumen}`, { archivo: S(archivo) }, { pagos: hechos.length }),
      ...hechos.map(h => hist("resultado de pago", refN(n), `${fmtRut(h.p.rut)} ${h.p.nombre} (${money(h.p.monto)}): ${h.antes.estado} → ${h.p.estado}${h.p.motivo ? ", motivo: " + h.p.motivo : ""} (reporte del banco)`, h.antes, { estado: h.p.estado, motivo: h.p.motivo }))
    ]
  };
});
// Cobro en banco de un pago cash o vale vista pagado: "" (pendiente de cobro), "cobrado" o "devuelto".
export const cobroPago = (id, i, cobro, fecha) => modificarNomina(id, n => {
  if (n.estado !== "cargada") throw new Conflicto("El cobro se registra con la nómina cargada");
  const pagos = n.pagos.map(p => ({ ...p })); const p = pagos[i];
  if (!esCobroCaja(n, p) || p.estado !== "pagado") throw new Conflicto("Solo un pago cash o vale vista pagado tiene cobro en banco");
  if (p.reint) throw new Conflicto("Este pago ya volvió a pendientes; no se puede cambiar");
  if (!["", "cobrado", "devuelto"].includes(cobro)) throw new Conflicto("Estado de cobro desconocido");
  const antes = { cobro: p.cobro || "", cobroFecha: p.cobroFecha || "" };
  p.cobro = cobro; p.cobroFecha = cobro ? (S(fecha) || todayISO()) : "";
  if (antes.cobro === p.cobro && antes.cobroFecha === p.cobroFecha) return { cambios: {} };
  const txt = { "": "pendiente de cobro", cobrado: "cobrado", devuelto: "no cobrado, devuelto a la cuenta" };
  return { cambios: { pagos }, hist: [hist("cobro en banco", refN(n), `${fmtRut(p.rut)} ${p.nombre} (${money(p.monto)}): ${txt[antes.cobro]} → ${txt[p.cobro]}${p.cobroFecha ? " el " + fmtISO(p.cobroFecha) : ""}`, antes, { cobro: p.cobro, cobroFecha: p.cobroFecha })] };
});
export const volverPendientes = (id, i) => modificarNomina(id, n => {
  const pagos = n.pagos.map(p => ({ ...p })); const p = pagos[i];
  const dev = noCobrado(n, p);
  if ((p.estado !== "rechazado" && !dev) || p.reint) throw new Conflicto("Este pago no está rechazado ni devuelto, o ya se reintegró");
  if (!conDocumentos(n) && !conAbonos(n)) throw new Conflicto("Esta transferencia no pagaba documentos ni abonos del panel: no hay nada que volver a pendientes");
  p.reint = todayISO();
  const donde = tipoDe(n) === "transferencia" ? `transferencia N° ${n.operacion || n.num}` : `nómina N° ${n.num}`;
  const texto = dev ? `No cobrado en banco en nómina N° ${n.num} (devuelto a la cuenta)` : `Rechazado en ${donde}${p.motivo ? ": " + p.motivo : ""}`;
  const que = conAbonos(n) ? "abono" : conDocumentos(n) ? "documento" : "pago";
  return {
    cambios: { pagos }, ...devolver(n, [p], texto),
    hist: [hist(dev ? "reintegrar pago no cobrado" : "reintegrar pago rechazado", refN(n), `${p.docs.length} ${que}${p.docs.length > 1 ? "s" : ""} de ${fmtRut(p.rut)} ${p.nombre} vuelven a pendientes (${money(p.monto)})`, { estado: p.estado, motivo: p.motivo, cobro: p.cobro || "", reint: "" }, { reint: p.reint })]
  };
});
export const anularNomina = id => modificarNomina(id, n => {
  const tef = tipoDe(n) === "transferencia";
  if (!tef && n.estado !== "generada") throw new Conflicto("Solo se anula una nómina que no se ha cargado en el banco");
  // Si un pago ya volvió a pendientes, anular lo devolvería dos veces.
  if (tef && n.pagos.some(p => p.reint)) throw new Conflicto("Esta transferencia ya devolvió su pago a pendientes; no se puede anular");
  const texto = tef ? `Viene de la transferencia N° ${n.operacion || n.num} anulada` : `Viene de la nómina N° ${n.num} anulada`;
  const vuelta = devolver(n, n.pagos, texto), cuantos = vuelta.docs.length + vuelta.abonos.length;
  const que = conAbonos(n) ? "abonos" : "documentos";
  return { cambios: { estado: "anulada" }, ...vuelta, hist: [hist(tef ? "anular transferencia" : "anular nómina", refN(n), tef ? `Transferencia N° ${n.operacion} (registro ${n.num}) anulada${cuantos ? `; ${cuantos} ${que} vuelven a pendientes` : ""}` : `N° ${n.num} ${n.fuente} anulada; ${cuantos} ${que} vuelven a pendientes`, { estado: n.estado }, { estado: "anulada" })] };
});

// ---------- transferencias electrónicas ----------
// t = { origen: "documentos"|"abonos"|"suelto", ids, fuente, operacion, idTef, fecha, hora,
//       cuentaOrigen, cuentaNombre, concepto, mensaje, preparo, autorizo, obs, monto,
//       benef: { rut, nombre, email, banco, forma, cuenta } }
// Toma el mismo correlativo que las nóminas y nace pagada (el banco la autoriza al instante).
export const registrarTransferencia = t => conReintento(al => runTransaction(db, async tx => {
  const cSnap = await tx.get(refContador());
  const num = cSnap.exists() ? cSnap.data().nextNum : 1;
  al(num);
  const nRef = doc(db, C.nom, String(num));
  const ref = id => t.origen === "abonos" ? refAbono(id) : refDoc(id);
  const [nSnap, iSnaps] = await Promise.all([tx.get(nRef), Promise.all((t.origen === "suelto" ? [] : t.ids).map(id => tx.get(ref(id))))]);
  if (nSnap.exists()) throw new Conflicto(`El registro N° ${num} ya existe. Recarga la página e inténtalo de nuevo.`);
  const movidos = iSnaps.filter(s => !s.exists() || s.data().rut !== t.benef.rut).length;
  if (movidos) throw new Conflicto(`${movidos} ${t.origen === "abonos" ? "abono" : "documento"}${movidos > 1 ? "s" : ""} ya no está${movidos > 1 ? "n" : ""} pendiente${movidos > 1 ? "s" : ""} (otro usuario lo movió, quitó o incluyó en una nómina). No se registró la transferencia; revisa y vuelve a intentarlo.`);
  const items = iSnaps.map((s, i) => ({ id: t.ids[i], ...s.data() }));
  const docs = t.origen === "documentos" ? items.map(d => ({ docId: d.id, fecha: d.fecha, monto: d.monto, ndoc: d.ndoc, tipo: d.tipo, dc: d.dc || "" }))
    : t.origen === "abonos" ? items.map(a => ({ abonoId: a.id, monto: a.monto, concepto: a.concepto || "", glosa: a.glosa || "" }))
    : [{ monto: t.monto, concepto: S(t.concepto), glosa: S(t.mensaje) }];
  const b = t.benef;
  const nomina = {
    num, tipo: "transferencia", origen: t.origen, fuente: t.fuente, archivo: "", estado: "cargada",
    creadaAt: serverTimestamp(), creadaPor: st.email, cargadaPor: st.email, cargadaAt: serverTimestamp(),
    fechaCarga: t.fecha, fechaPago: t.fecha, horaTef: S(t.hora), operacion: S(t.operacion), idTef: S(t.idTef),
    cuentaOrigen: S(t.cuentaOrigen), cuentaNombre: S(t.cuentaNombre), concepto: S(t.concepto), mensaje: S(t.mensaje),
    preparo: S(t.preparo), autorizo: S(t.autorizo), obs: S(t.obs), total: t.monto, lineas: [],
    pagos: [{ rut: b.rut, nombre: S(b.nombre), email: S(b.email), banco: S(b.banco), forma: S(b.forma), cuenta: S(b.cuenta), monto: t.monto, estado: "pagado", motivo: "", reint: "", docs }],
    ...f()
  };
  if (cSnap.exists()) tx.update(refContador(), { nextNum: num + 1, ...f() });
  else tx.set(refContador(), { nextNum: num + 1, ...f() });
  tx.set(nRef, nomina);
  items.forEach(it => tx.delete(ref(it.id)));
  const que = t.origen === "documentos" ? `, ${docs.length} documento${docs.length > 1 ? "s" : ""}` : t.origen === "abonos" ? `, ${docs.length} abono${docs.length > 1 ? "s" : ""}` : ", pago sin documento en el panel";
  tx.set(refHist(), hist("registrar transferencia", "nomina:" + num, `Transferencia N° ${nomina.operacion} (registro ${num}) del ${fmtISO(t.fecha)}${t.hora ? " " + t.hora : ""}, ${t.fuente}: ${fmtRut(b.rut)} ${nomina.pagos[0].nombre}, ${money(t.monto)}${que}. ${nomina.concepto}${t.pdf ? `. Leída del PDF ${S(t.pdf)}` : ""}`, null, { operacion: nomina.operacion, idTef: nomina.idTef, total: t.monto, origen: t.origen, tipo: "transferencia" }));
  return nomina;
}));

// Datos de la transferencia que se pueden corregir después de registrarla.
const CAMPOS_TEF = { operacion: "N° de transferencia", idTef: "ID TEF", horaTef: "hora", concepto: "concepto", mensaje: "mensaje", preparo: "preparó", autorizo: "autorizó", obs: "observación" };
export const editarTransferencia = (id, datos) => modificarNomina(id, n => {
  if (tipoDe(n) !== "transferencia") throw new Conflicto("No es una transferencia");
  const antes = Object.fromEntries(Object.keys(CAMPOS_TEF).map(k => [k, S(n[k])]));
  const despues = Object.fromEntries(Object.keys(CAMPOS_TEF).map(k => [k, k in datos ? S(datos[k]) : antes[k]]));
  const cambiados = Object.keys(CAMPOS_TEF).filter(k => antes[k] !== despues[k]);
  if (!cambiados.length) return { cambios: {} };
  return { cambios: despues, hist: [hist("editar transferencia", refN(n), "Cambia " + cambiados.map(k => CAMPOS_TEF[k]).join(", "), antes, despues)] };
});

// ---------- respaldo JSON (exportar e importar) ----------
const iso = t => { const d = aFecha(t); return d ? d.toISOString() : "" };
export function exportarRespaldo() {
  const limpia = o => { const { updatedAt, updatedBy, createdAt, createdBy, ...r } = o; return r };
  return {
    version: 2, exportado: new Date().toISOString(),
    maestro: Object.fromEntries(Object.entries(st.maestro).map(([k, p]) => [k, soloProv(p)])),
    docs: st.docs.map(d => ({ ...limpia(d) })),
    abonos: st.abonos.map(a => ({ ...limpia(a) })),
    nominas: st.nominas.map(n => ({ ...limpia(n), creadaAt: iso(n.creadaAt) })),
    config: { fuentes: st.config.fuentes, email: st.config.emailDefecto, feriados: st.config.feriados, prefijoArchivo: st.config.prefijoArchivo, cuentas: st.config.cuentas, nextNum: st.nextNum }
  };
}

// Acepta { maestro, docs, nominas, config } (respaldo de la referencia o de
// este panel) o las claves de localStorage bepago.*.v1, con valores en texto o no.
export function leerRespaldo(obj) {
  const val = v => typeof v === "string" ? JSON.parse(v) : v;
  const get = (k, kLs) => obj[k] !== undefined ? val(obj[k]) : obj[kLs] !== undefined ? val(obj[kLs]) : undefined;
  const maestro = get("maestro", "bepago.maestro.v1") || {};
  const docs = get("docs", "bepago.docs.v1") || [];
  const nominas = get("nominas", "bepago.nominas.v1") || [];
  const config = get("config", "bepago.config.v1") || {};
  if (typeof maestro !== "object" || !Array.isArray(docs) || !Array.isArray(nominas)) throw new Error("el archivo no tiene la forma { maestro, docs, nominas, config }");
  return { maestro, docs, nominas, config };
}

// Resumen previo: qué se escribirá y qué no se puede importar.
export function analizarRespaldo(r) {
  const provs = Object.values(r.maestro).filter(p => p && S(p.rut)).map(p => ({ rut: S(p.rut), nombre: S(p.nombre), email: S(p.email), banco: S(p.banco), forma: S(p.forma), cuenta: S(p.cuenta), sector: S(p.sector) }));
  const provNuevos = provs.filter(p => !st.maestro[p.rut]).length;
  const provCambian = provs.filter(p => st.maestro[p.rut] && CAMPOS_PROV.some(k => S(st.maestro[p.rut][k]) !== p[k])).length;
  const docsOk = [], docsMalos = [];
  r.docs.forEach(d => {
    const o = { rut: S(d.rut), fecha: S(d.fecha), monto: d.monto, ndoc: S(d.ndoc), tipo: S(d.tipo), fuente: S(d.fuente) || "GENERAL", sel: d.sel !== false };
    if (d.hist) o.hist = S(d.hist); if (normDc(d.dc)) o.dc = normDc(d.dc);
    (Number.isInteger(o.monto) && o.monto > 0 ? docsOk : docsMalos).push(o);
  });
  const nominas = r.nominas.map(n => ({
    num: n.num, fuente: S(n.fuente), archivo: S(n.archivo), estado: n.estado,
    creada: n.creadaAt || n.creada || "", creadaPor: S(n.creadaPor),
    fechaCarga: S(n.fechaCarga), fechaPago: S(n.fechaPago), operacion: S(n.operacion), obs: S(n.obs), total: n.total,
    lineas: (n.lineas || n.lines || []).map(l => ({ tipo: l.tipo || l.type, f: l.f.map(S) })),
    pagos: (n.pagos || []).map(p => ({ rut: S(p.rut), nombre: S(p.nombre), banco: S(p.banco), cuenta: S(p.cuenta), monto: p.monto, estado: p.estado || "pendiente", motivo: S(p.motivo), reint: S(p.reint), docs: (p.docs || []).map(d => ({ docId: S(d.docId), fecha: S(d.fecha), monto: d.monto, ndoc: S(d.ndoc), tipo: S(d.tipo), dc: normDc(d.dc) })) }))
  })).sort((a, b) => a.num - b.num);
  const avisos = [];
  let importarNominas = nominas.length > 0;
  if (nominas.length) {
    if (st.nominas.length) { importarNominas = false; avisos.push(`Firestore ya tiene ${st.nominas.length} nóminas: las nóminas del respaldo no se importan (solo se migran una vez, con la bitácora vacía).`) }
    else if (nominas.some((n, i) => !Number.isInteger(n.num) || n.num !== nominas[0].num + i)) { importarNominas = false; avisos.push("Los números de nómina del respaldo no son correlativos: no se pueden recrear respetando el contador.") }
    else if (st.contadorExiste && st.nextNum !== nominas[0].num) { importarNominas = false; avisos.push(`El contador de Firestore va en ${st.nextNum} y el respaldo parte en ${nominas[0].num}.`) }
    else if (nominas.some(n => !["generada", "cargada", "anulada"].includes(n.estado))) { importarNominas = false; avisos.push("Hay nóminas con un estado desconocido.") }
  }
  if (docsMalos.length) avisos.push(`${docsMalos.length} documentos pendientes tienen monto inválido y no se importan (Firestore exige entero mayor que cero).`);
  if (st.docs.length && docsOk.length) avisos.push(`Ya hay ${st.docs.length} documentos pendientes en Firestore; los del respaldo se agregan a ellos.`);
  const fuentes = [...st.config.fuentes];
  [...(Array.isArray(r.config.fuentes) ? r.config.fuentes : []), ...docsOk.map(d => d.fuente), ...nominas.map(n => n.fuente)].forEach(x => { if (x && !fuentes.includes(x)) fuentes.push(x) });
  return { provs, provNuevos, provCambian, docsOk, docsMalos, nominas, importarNominas, avisos, fuentes, email: S(r.config.email) || st.config.emailDefecto };
}

export async function importarRespaldo(a, alAvanzar = () => { }) {
  const ops = [opConfig({ fuentes: a.fuentes, emailDefecto: a.email })];
  a.provs.forEach(p => ops.push(...opsProveedor(st.maestro[p.rut] || null, p, "importar respaldo")));
  a.docsOk.forEach(d => ops.push(b => b.set(refDoc(nuevoIdDoc()), { ...d, createdAt: serverTimestamp(), createdBy: st.email, ...f() })));
  ops.push(b => b.set(refHist(), hist("importar respaldo", "config", `${a.provs.length} proveedores, ${a.docsOk.length} documentos pendientes${a.importarNominas ? ", " + a.nominas.length + " nóminas" : ""}`)));
  alAvanzar("Proveedores y documentos");
  await enLotes(ops, (i, n) => alAvanzar(`Proveedores y documentos: ${i} de ${n} escrituras`));
  if (!a.importarNominas) return;
  // Las reglas solo dejan crear nóminas en estado 'generada' y con el
  // contador en num + 1: se recrean en orden y luego se pasan a su estado.
  for (const [i, n] of a.nominas.entries()) {
    alAvanzar(`Nómina N° ${n.num} (${i + 1} de ${a.nominas.length})`);
    await runTransaction(db, async tx => {
      const c = await tx.get(refContador());
      const actual = c.exists() ? c.data().nextNum : n.num;
      if (actual !== n.num) throw new Conflicto(`El contador va en ${actual} y la nómina es la N° ${n.num}`);
      if (c.exists()) tx.update(refContador(), { nextNum: n.num + 1, ...f() }); else tx.set(refContador(), { nextNum: n.num + 1, ...f() });
      const { creada, estado, ...resto } = n;
      tx.set(doc(db, C.nom, String(n.num)), { ...resto, estado: "generada", creadaAt: creada ? Timestamp.fromDate(new Date(creada)) : serverTimestamp(), creadaPor: n.creadaPor || st.email, ...f() });
      tx.set(refHist(), hist("migrar nómina", "nomina:" + n.num, `Importada desde el respaldo del panel anterior, estado ${estado}`, null, { estado }));
    });
    if (n.estado !== "generada") {
      const b = writeBatch(db);
      b.update(doc(db, C.nom, String(n.num)), { estado: n.estado, ...f() });
      await b.commit();
    }
  }
}
