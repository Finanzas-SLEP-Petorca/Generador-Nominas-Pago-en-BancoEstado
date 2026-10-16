// Pruebas del bloque de reglas con el emulador de Firestore.
//   cd tests && npm install && npm run reglas
// Usa los correos marcadores del bloque (admin1@example.com, usuario1@example.com).
import { readFileSync } from "node:fs";
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { doc, collection, getDoc, getDocs, setDoc, updateDoc, deleteDoc, writeBatch, runTransaction, serverTimestamp } from "firebase/firestore";

const ADMIN = "admin1@example.com", USUARIO = "usuario1@example.com", FUERA = "fuera@example.com";
let env;
before(async () => {
  env = await initializeTestEnvironment({ projectId: "demo-pago", firestore: { rules: readFileSync(new URL("./.generado/firestore.rules", import.meta.url), "utf8"), host: "127.0.0.1", port: 8080 } });
});
after(() => env.cleanup());
beforeEach(() => env.clearFirestore());

const db = (email, verificado = true) => env.authenticatedContext(email.replace(/\W/g, "_"), { email, email_verified: verificado }).firestore();
const firma = email => ({ updatedBy: email, updatedAt: serverTimestamp() });
const prov = (rut, email, extra = {}) => ({ rut, nombre: "PROVEEDOR DE PRUEBA", email: "", banco: "012", forma: "01", cuenta: "11111111", sector: "64", createdAt: serverTimestamp(), createdBy: email, ...firma(email), ...extra });
const docPend = (email, extra = {}) => ({ rut: "111111111", fecha: "01092026", monto: 1000, ndoc: "10", tipo: "33", fuente: "SEP", sel: true, ...firma(email), ...extra });
const sembrar = fn => env.withSecurityRulesDisabled(ctx => fn(ctx.firestore()));

// Misma transacción y reintento que datos.generarNomina (simplificada).
async function generar(fs, email, docIds = []) {
  for (let intento = 0; ; intento++) {
    let usado = null;
    try { return await transaccion(fs, email, docIds, n => { usado = n }) }
    catch (e) {
      if (e.code !== "permission-denied" || usado == null || intento >= 5) throw e;
      await new Promise(ok => setTimeout(ok, 100 * (intento + 1) + Math.random() * 150));
    }
  }
}
function transaccion(fs, email, docIds, alReservar) {
  return runTransaction(fs, async tx => {
    const c = await tx.get(doc(fs, "pago_config/contador"));
    const num = c.exists() ? c.data().nextNum : 1;
    alReservar(num);
    const snaps = await Promise.all(docIds.map(id => tx.get(doc(fs, "pago_documentos", id))));
    if (snaps.some(s => !s.exists() || !s.data().sel)) throw new Error("documento movido");
    if (c.exists()) tx.update(doc(fs, "pago_config/contador"), { nextNum: num + 1, ...firma(email) });
    else tx.set(doc(fs, "pago_config/contador"), { nextNum: num + 1, ...firma(email) });
    tx.set(doc(fs, "pago_nominas", String(num)), { num, fuente: "SEP", archivo: "X_SEP", estado: "generada", creadaAt: serverTimestamp(), creadaPor: email, fechaCarga: "", operacion: "", obs: "", total: 1000, lineas: [{ tipo: 1, f: ["1"] }], pagos: [], ...firma(email) });
    docIds.forEach(id => tx.delete(doc(fs, "pago_documentos", id)));
    tx.set(doc(collection(fs, "pago_historial")), { accion: "generar nómina", ref: "nomina:" + num, detalle: "", antes: null, despues: null, autor: email, createdAt: serverTimestamp() });
    return num;
  });
}

test("un usuario fuera de pAllowed() no puede leer nada", async () => {
  await sembrar(async fs => {
    await setDoc(doc(fs, "pago_config/general"), { fuentes: ["SEP"] });
    await setDoc(doc(fs, "pago_proveedores/111111111"), { rut: "111111111" });
    await setDoc(doc(fs, "pago_documentos/a"), { monto: 1 });
    await setDoc(doc(fs, "pago_nominas/1"), { num: 1 });
    await setDoc(doc(fs, "pago_historial/h"), { accion: "x" });
  });
  for (const fs of [db(FUERA), db(USUARIO, false), env.unauthenticatedContext().firestore()]) {
    await assertFails(getDoc(doc(fs, "pago_config/general")));
    for (const c of ["pago_proveedores", "pago_documentos", "pago_nominas", "pago_historial", "pago_config"]) await assertFails(getDocs(collection(fs, c)));
    await assertFails(setDoc(doc(fs, "pago_proveedores/111111111"), prov("111111111", FUERA)));
  }
  await assertSucceeds(getDocs(collection(db(USUARIO), "pago_proveedores")));
  await assertSucceeds(getDoc(doc(db(ADMIN), "pago_config/general")));
});

test("escrituras firmadas y con campos permitidos", async () => {
  const u = db(USUARIO);
  await assertSucceeds(setDoc(doc(u, "pago_proveedores/111111111"), prov("111111111", USUARIO)));
  await assertFails(setDoc(doc(u, "pago_proveedores/111111111"), prov("111111111", USUARIO, { updatedBy: ADMIN })));
  await assertFails(setDoc(doc(u, "pago_proveedores/222222222"), prov("111111111", USUARIO)));
  await assertFails(setDoc(doc(u, "pago_proveedores/111111111"), prov("111111111", USUARIO, { extra: 1 })));
  await assertSucceeds(setDoc(doc(u, "pago_documentos/a"), docPend(USUARIO, { dc: "DC 54", hist: "Viene de la nómina N° 1 anulada" })));
  await assertFails(setDoc(doc(u, "pago_documentos/b"), docPend(USUARIO, { monto: 0 })));
  await assertFails(setDoc(doc(u, "pago_documentos/b"), docPend(USUARIO, { monto: 10.5 })));
  await assertSucceeds(updateDoc(doc(u, "pago_documentos/a"), { sel: false, ...firma(USUARIO) }));
  await assertSucceeds(setDoc(doc(u, "pago_config/general"), { fuentes: ["SEP"], emailDefecto: "", feriados: ["2026-09-18"], prefijoArchivo: "AAAAMMDD_PAGO_PROVEEDORES", ...firma(USUARIO) }));
  await assertFails(setDoc(doc(u, "pago_config/general"), { fuentes: "SEP", ...firma(USUARIO) }));
  await assertFails(setDoc(doc(u, "pago_config/general"), { fuentes: [], group: true, ...firma(USUARIO) }));
});

test("solo pAdmin borra proveedores (y la sonda de administrador no cambia nada)", async () => {
  await sembrar(fs => setDoc(doc(fs, "pago_proveedores/111111111"), { rut: "111111111" }));
  await assertFails(deleteDoc(doc(db(USUARIO), "pago_proveedores/111111111")));
  await assertFails(deleteDoc(doc(db(USUARIO), "pago_proveedores/SONDA-ADMIN")));
  await assertSucceeds(deleteDoc(doc(db(ADMIN), "pago_proveedores/SONDA-ADMIN")));
  await assertSucceeds(deleteDoc(doc(db(ADMIN), "pago_proveedores/111111111")));
});

test("el contador solo avanza de uno en uno", async () => {
  const u = db(USUARIO);
  await assertSucceeds(setDoc(doc(u, "pago_config/contador"), { nextNum: 2, ...firma(USUARIO) }));
  await assertFails(updateDoc(doc(u, "pago_config/contador"), { nextNum: 4, ...firma(USUARIO) }));
  await assertFails(updateDoc(doc(u, "pago_config/contador"), { nextNum: 1, ...firma(USUARIO) }));
  await assertSucceeds(updateDoc(doc(u, "pago_config/contador"), { nextNum: 3, ...firma(USUARIO) }));
  await assertFails(deleteDoc(doc(u, "pago_config/contador")));
});

test("una nómina solo nace generada, con el número que reserva el contador", async () => {
  const u = db(USUARIO);
  const nom = (num, extra = {}) => ({ num, fuente: "SEP", archivo: "X", estado: "generada", creadaAt: serverTimestamp(), creadaPor: USUARIO, total: 1, lineas: [], pagos: [], ...firma(USUARIO), ...extra });
  // Sin mover el contador: rechazada.
  await assertFails(setDoc(doc(u, "pago_nominas/1"), nom(1)));
  // Estado distinto de generada: rechazada aunque el contador avance.
  let b = writeBatch(u); b.set(doc(u, "pago_config/contador"), { nextNum: 2, ...firma(USUARIO) }); b.set(doc(u, "pago_nominas/1"), nom(1, { estado: "cargada" }));
  await assertFails(b.commit());
  assert.equal(await generar(u, USUARIO), 1);
  assert.equal(await generar(u, USUARIO), 2);
  // Repetir un número existente no se puede.
  b = writeBatch(u); b.update(doc(u, "pago_config/contador"), { nextNum: 4, ...firma(USUARIO) }); b.set(doc(u, "pago_nominas/2"), nom(3));
  await assertFails(b.commit());
});

test("la fuente de una nómina se corrige sola, sin cambiar de estado en el mismo paso", async () => {
  const u = db(USUARIO);
  const num = await generar(u, USUARIO);
  const ref = doc(u, "pago_nominas/" + num);
  await assertSucceeds(updateDoc(ref, { fuente: "PIE", ...firma(USUARIO) }));
  await assertFails(updateDoc(ref, { fuente: "", ...firma(USUARIO) }));
  await assertFails(updateDoc(ref, { fuente: "SEP", estado: "cargada", ...firma(USUARIO) }));
  await assertSucceeds(updateDoc(ref, { estado: "cargada", cargadaPor: USUARIO, cargadaAt: serverTimestamp(), ...firma(USUARIO) }));
  await assertSucceeds(updateDoc(ref, { fuente: "SEP", ...firma(USUARIO) }));               // ya cargada, también
});

test("una transferencia electrónica nace cargada, firmada por quien la registra, y se puede anular", async () => {
  const u = db(USUARIO);
  const tef = (num, extra = {}) => ({ num, tipo: "transferencia", fuente: "JUNJI", archivo: "", estado: "cargada", creadaAt: serverTimestamp(), creadaPor: USUARIO, cargadaPor: USUARIO, cargadaAt: serverTimestamp(), fechaCarga: "2026-09-30", fechaPago: "2026-09-30", operacion: "8800001", total: 250000, lineas: [], pagos: [], ...firma(USUARIO), ...extra });
  const conContador = (fs, n, nom) => { const b = writeBatch(fs); b.set(doc(fs, "pago_config/contador"), { nextNum: n + 1, ...firma(USUARIO) }); b.set(doc(fs, "pago_nominas", String(n)), nom); return b.commit() };
  // Sin tipo transferencia no puede nacer cargada; tampoco a nombre de otro ni sin la hora del servidor.
  await assertFails(conContador(u, 1, tef(1, { tipo: "abonos" })));
  await assertFails(conContador(u, 1, tef(1, { cargadaPor: ADMIN })));
  await assertFails(conContador(u, 1, tef(1, { cargadaAt: null })));
  await assertFails(conContador(u, 1, tef(1, { estado: "anulada" })));
  await assertSucceeds(conContador(u, 1, tef(1)));
  // El contador sigue siendo el mismo: la nómina siguiente es la 2.
  assert.equal(await generar(u, USUARIO), 2);
  // Una transferencia se puede anular (registrada por error); una nómina cargada no.
  await assertSucceeds(updateDoc(doc(u, "pago_nominas/1"), { estado: "anulada", ...firma(USUARIO) }));
  await assertFails(updateDoc(doc(u, "pago_nominas/1"), { obs: "x", ...firma(USUARIO) }));
  await updateDoc(doc(u, "pago_nominas/2"), { estado: "cargada", cargadaPor: USUARIO, cargadaAt: serverTimestamp(), ...firma(USUARIO) });
  await assertFails(updateDoc(doc(u, "pago_nominas/2"), { estado: "anulada", ...firma(USUARIO) }));
  // Cuentas de origen en la configuración: lista.
  await assertSucceeds(setDoc(doc(u, "pago_config/general"), { fuentes: ["JUNJI"], cuentas: [{ cuenta: "11100000001", nombre: "Subvencion JUNJI", fuente: "JUNJI" }], ...firma(USUARIO) }));
  await assertFails(setDoc(doc(u, "pago_config/general"), { fuentes: ["JUNJI"], cuentas: "11100000001", ...firma(USUARIO) }));
});

test("dos usuarios generando a la vez no obtienen el mismo número", async () => {
  const a = db(USUARIO), b = db(ADMIN);
  const nums = await Promise.all(Array.from({ length: 6 }, (_, i) => generar(i % 2 ? a : b, i % 2 ? USUARIO : ADMIN)));
  assert.deepEqual([...nums].sort((x, y) => x - y), [1, 2, 3, 4, 5, 6]);
  const c = await getDoc(doc(a, "pago_config/contador"));
  assert.equal(c.data().nextNum, 7);
});

test("generar aborta si otro usuario movió un documento", async () => {
  const u = db(USUARIO);
  await setDoc(doc(u, "pago_documentos/a"), docPend(USUARIO));
  await setDoc(doc(u, "pago_documentos/b"), docPend(USUARIO));
  await updateDoc(doc(db(ADMIN), "pago_documentos/b"), { sel: false, ...firma(ADMIN) });
  await assert.rejects(generar(u, USUARIO, ["a", "b"]), /documento movido/);
  assert.ok((await getDoc(doc(u, "pago_documentos/a"))).exists());
  assert.equal((await getDoc(doc(u, "pago_config/contador"))).exists(), false);
  assert.equal(await generar(u, USUARIO, ["a"]), 1);
  assert.equal((await getDoc(doc(u, "pago_documentos/a"))).exists(), false);
});

test("una nómina anulada no se puede volver a editar; solo se anula si está generada", async () => {
  const u = db(USUARIO);
  await generar(u, USUARIO); await generar(u, USUARIO);
  const ref1 = doc(u, "pago_nominas/1"), ref2 = doc(u, "pago_nominas/2");
  // Datos de origen protegidos.
  await assertFails(updateDoc(ref1, { total: 5, ...firma(USUARIO) }));
  await assertFails(updateDoc(ref1, { lineas: [], ...firma(USUARIO) }));
  await assertFails(updateDoc(ref1, { estado: "pagada", ...firma(USUARIO) }));
  // Cargada → anulada: no.
  await assertSucceeds(updateDoc(ref2, { estado: "cargada", fechaCarga: "2026-09-25", ...firma(USUARIO) }));
  await assertFails(updateDoc(ref2, { estado: "anulada", ...firma(USUARIO) }));
  // Generada → anulada con documentos de vuelta en un batch.
  const b = writeBatch(u);
  b.update(ref1, { estado: "anulada", ...firma(USUARIO) });
  b.set(doc(u, "pago_documentos/r1"), docPend(USUARIO, { hist: "Viene de la nómina N° 1 anulada" }));
  b.set(doc(collection(u, "pago_historial")), { accion: "anular nómina", ref: "nomina:1", detalle: "", antes: null, despues: null, autor: USUARIO, createdAt: serverTimestamp() });
  await assertSucceeds(b.commit());
  // Cerrada.
  for (const cambio of [{ estado: "generada" }, { estado: "anulada", obs: "x" }, { obs: "x" }, { pagos: [] }]) await assertFails(updateDoc(ref1, { ...cambio, ...firma(USUARIO) }));
  await assertFails(updateDoc(doc(db(ADMIN), "pago_nominas/1"), { obs: "x", ...firma(ADMIN) }));
  await assertFails(deleteDoc(ref1));
});

test("cargadaPor solo puede ser quien escribe", async () => {
  const u = db(USUARIO);
  await generar(u, USUARIO);
  const ref = doc(u, "pago_nominas/1");
  await assertFails(updateDoc(ref, { estado: "cargada", fechaCarga: "2026-09-26", fechaPago: "2026-09-29", cargadaPor: ADMIN, cargadaAt: serverTimestamp(), ...firma(USUARIO) }));
  await assertFails(updateDoc(ref, { estado: "cargada", cargadaPor: USUARIO, cargadaAt: new Date(2020, 0, 1), ...firma(USUARIO) }));
  await assertSucceeds(updateDoc(ref, { estado: "cargada", fechaCarga: "2026-09-26", fechaPago: "2026-09-29", cargadaPor: USUARIO, cargadaAt: serverTimestamp(), ...firma(USUARIO) }));
  // Guardar otros cambios no toca cargadaPor; deshacer la carga lo limpia.
  await assertSucceeds(updateDoc(doc(db(ADMIN), "pago_nominas/1"), { obs: "x", ...firma(ADMIN) }));
  await assertSucceeds(updateDoc(doc(db(ADMIN), "pago_nominas/1"), { estado: "generada", fechaCarga: "", fechaPago: "", cargadaPor: "", cargadaAt: null, ...firma(ADMIN) }));
});

test("abonos pendientes: firmados, con campos permitidos y monto entero", async () => {
  const u = db(USUARIO);
  const ab = (extra = {}) => ({ rut: "111111111", nombre: "UNO", email: "", banco: "012", forma: "29", cuenta: "0", monto: 1000, fuente: "SEP", concepto: "FONDOS FIJOS", sel: true, ...firma(USUARIO), ...extra });
  await assertSucceeds(setDoc(doc(u, "pago_abonos/a"), ab({ glosa: "Escuela X", hist: "Rechazado en nómina N° 3" })));
  await assertFails(setDoc(doc(u, "pago_abonos/b"), ab({ monto: 0 })));
  await assertFails(setDoc(doc(u, "pago_abonos/b"), ab({ monto: 10.5 })));
  await assertFails(setDoc(doc(u, "pago_abonos/b"), ab({ sector: "64" })));
  await assertFails(setDoc(doc(u, "pago_abonos/b"), ab({ updatedBy: ADMIN })));
  await assertSucceeds(updateDoc(doc(u, "pago_abonos/a"), { sel: false, ...firma(USUARIO) }));
  await assertFails(getDoc(doc(db(FUERA), "pago_abonos/a")));
  await assertSucceeds(deleteDoc(doc(u, "pago_abonos/a")));
});

test("el historial solo se agrega, firmado por quien escribe", async () => {
  const u = db(USUARIO);
  const h = (extra = {}) => ({ accion: "editar proveedor", ref: "proveedor:1", detalle: "", antes: { cuenta: "1" }, despues: { cuenta: "2" }, autor: USUARIO, createdAt: serverTimestamp(), ...extra });
  const ref = doc(collection(u, "pago_historial"));
  await assertSucceeds(setDoc(ref, h()));
  await assertFails(setDoc(doc(collection(u, "pago_historial")), h({ autor: ADMIN })));
  await assertFails(setDoc(doc(collection(u, "pago_historial")), h({ extra: 1 })));
  await assertFails(updateDoc(ref, { detalle: "cambiado" }));
  await assertFails(deleteDoc(ref));
  await assertFails(deleteDoc(doc(db(ADMIN), "pago_historial", ref.id)));
});
