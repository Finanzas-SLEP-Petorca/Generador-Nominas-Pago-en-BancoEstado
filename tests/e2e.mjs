// Prueba de punta a punta en Chromium: el panel nuevo contra los emuladores
// de Auth y Firestore, comparado con el panel de referencia con los mismos
// datos ficticios.  cd tests && npm run e2e
// (la primera vez en otro computador: npx playwright install chromium)
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const AQUI = new URL("./.generado/", import.meta.url).pathname; // salidas y Firebase empaquetado
const BASE = "http://localhost:5000";
const ADMIN = "admin1@example.com", USUARIO = "usuario1@example.com", FUERA = "fuera@example.com";
const log = (...a) => console.log("•", ...a);

const srv = spawn("python3", ["-m", "http.server", "5000", "--bind", "127.0.0.1", "--directory", REPO], { stdio: "ignore" });
await new Promise(r => setTimeout(r, 800));
const limpiarFirestore = () => fetch("http://127.0.0.1:8080/emulator/v1/projects/demo-pago/databases/(default)/documents", { method: "DELETE" });
await limpiarFirestore();

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
async function contexto(movil = false) {
  const ctx = await browser.newContext({ acceptDownloads: true, ...(movil ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 900 } }) });
  await ctx.route(/gstatic\.com\/firebasejs\/10\.14\.1\/(.*)$/, (route) => { const f = route.request().url().split("/").pop(); route.fulfill({ path: AQUI + "fb/" + f, contentType: "text/javascript" }) });
  await ctx.route(/cdnjs\.cloudflare\.com.*xlsx.*/, r => r.fulfill({ path: REPO + "/vendor/xlsx-0.18.5.full.min.js", contentType: "text/javascript" }));
  await ctx.route(/cdnjs\.cloudflare\.com.*jszip.*/, r => r.fulfill({ path: REPO + "/vendor/jszip-3.10.1.min.js", contentType: "text/javascript" }));
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  return ctx;
}
async function panel(email, movil = false) {
  const ctx = await contexto(movil); const p = await ctx.newPage();
  p.on("pageerror", e => console.log("  [pageerror " + email + "]", e.message));
  p.on("console", m => { if (!/ERR_FAILED|Failed to load resource/.test(m.text())) console.log("  [console " + m.type() + " " + email + "]", m.text().slice(0, 300)) });
  p.on("dialog", d => d.accept());
  await p.goto(BASE + "/?emulador");
  await p.waitForFunction(() => window.__entrarEmulador);
  await p.evaluate(e => window.__entrarEmulador(e), email);
  return p;
}
// Acceso real por enlace al correo: el emulador de Auth guarda los enlaces enviados.
async function panelEnlace(email) {
  const ctx = await contexto(); const p = await ctx.newPage();
  p.on("pageerror", e => console.log("  [pageerror " + email + "]", e.message));
  p.on("dialog", d => d.accept());
  await p.goto(BASE + "/?emulador");
  await p.waitForSelector("#accesoForm:not([hidden])");
  await p.fill("#accesoEmail", email); await p.click("#btnEntrar");
  await p.waitForFunction(() => document.getElementById("accesoMsg").textContent.startsWith("Enviamos un enlace"));
  const { oobCodes } = await (await fetch("http://127.0.0.1:9099/emulator/v1/projects/demo-pago/oobCodes")).json();
  const enlace = oobCodes.filter(c => c.email === email && c.requestType === "EMAIL_SIGNIN").pop().oobLink;
  await p.goto(enlace); // el emulador redirige al panel con el código del enlace
  return p;
}
const listo = p => p.waitForFunction(() => !document.getElementById("app").hidden && document.getElementById("cargando").hidden);
const toastTxt = p => p.textContent("#toast");
// Espera n descargas seguidas (generar baja el .txt y el Excel BancoEstado).
async function descargas(p, n, accion) {
  const lista = []; const listo = new Promise(ok => { const f = async d => { lista.push({ nombre: d.suggestedFilename(), bytes: readFileSync(await d.path()) }); if (lista.length === n) { p.off("download", f); ok() } }; p.on("download", f) });
  await accion(); await listo; return lista;
}
async function descarga(p, accion) { const [d] = await Promise.all([p.waitForEvent("download"), accion()]); return { nombre: d.suggestedFilename(), bytes: readFileSync(await d.path()) } }
const esperar = (p, fn, arg) => p.waitForFunction(fn, arg, { timeout: 10000 });

// Comprobante de transferencia ficticio con el diseño de BancoEstado, en un PDF
// con la misma estructura que el del banco (imagen RGB con Flate y SMask).
async function pdfTransferencia(d) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1.25 });
  const p = await ctx.newPage();
  const fecha = "29/09/2026", v = (l, x, st = "") => `<div><div class="l">${l}</div><div class="v"${st}>${x}</div></div>`;
  await p.setContent(`<style>html,body{background:transparent}body{margin:0;padding:24px 30px;font:22px Arial,sans-serif;color:#333;width:1540px}h1{font-weight:400;font-size:32px;margin:0 0 40px}
    section{border-bottom:1px solid #ccc;padding:18px 0}.g3{display:grid;grid-template-columns:1fr 1fr 1fr}.g2{display:grid;grid-template-columns:1fr 2fr}.l{color:#555}.v{font-weight:700;margin-top:6px}
    table{width:100%;border-collapse:collapse;margin-top:16px}td,th{padding:14px;text-align:left;border-bottom:1px solid #ddd}</style>
    <h1>Detalle Transferencia Electrónica | N° ${d.num}</h1>
    <section class="g3">${v("Fecha Transacción", fecha + " - " + d.hora)}${v("ID TEF", d.idTef)}${v("Estado", "Autorizada", ' style="color:#3a3"')}</section>
    <section>${v("Cuenta Origen", d.cuenta + " | " + d.cuentaNombre)}</section>
    <section><div class="l">Beneficiario</div><div class="v">${d.alias}</div><div class="v">${d.nombre} | ${d.rut} | BANCO DEL ESTADO DE CHILE | Cuenta Corriente ${d.cuentaB}</div><div>contacto@ejemplo.cl;</div></section>
    <section class="g2">${v("Monto", "$" + d.monto.toLocaleString("es-CL"))}${v("Concepto", d.concepto)}</section>
    <section>${v("Mensaje a Beneficiario", d.mensaje)}</section>
    <h2 style="font-weight:400;font-size:26px;margin-top:40px">Intervinientes</h2>
    <table><tr><th>Rut</th><th>Nombre</th><th>Fecha</th><th>Acción</th></tr>
    <tr><td>11.111.111-1</td><td>Usuario Uno</td><td>${fecha} - 11:00</td><td>Preparación</td></tr>
    <tr><td>22.222.222-2</td><td>Administrador Uno</td><td>${fecha} - 11:05</td><td>Autorizacion 1</td></tr>
    <tr><td>33.333.333-3</td><td>Usuario Dos</td><td>${fecha} - 11:10</td><td>Autorizacion 2</td></tr></table>`);
  const png = await p.screenshot({ fullPage: true, omitBackground: true });
  const { w, h, b64 } = await p.evaluate(async src => {
    const img = new Image(); img.src = "data:image/png;base64," + src; await img.decode();
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
    const g = c.getContext("2d"); g.drawImage(img, 0, 0);
    const px = g.getImageData(0, 0, c.width, c.height).data; let s = "";
    for (let i = 0; i < px.length; i += 0x8000) s += String.fromCharCode.apply(null, px.subarray(i, i + 0x8000));
    return { w: c.width, h: c.height, b64: btoa(s) };
  }, png.toString("base64"));
  await ctx.close();
  const rgba = Buffer.from(b64, "base64"), rgb = Buffer.alloc(w * h * 3), alfa = Buffer.alloc(w * h);
  for (let i = 0; i < w * h; i++) { rgba.copy(rgb, i * 3, i * 4, i * 4 + 3); alfa[i] = rgba[i * 4 + 3] }
  const { deflateSync } = await import("node:zlib");
  const img = deflateSync(rgb), masc = deflateSync(alfa), L = s => Buffer.from(s, "latin1");
  return Buffer.concat([L("%PDF-1.3\n"),
    L(`5 0 obj\n<</Type /XObject /Subtype /Image /BitsPerComponent 8 /Width ${w} /Height ${h} /Filter /FlateDecode /ColorSpace /DeviceRGB /SMask 6 0 R /Length ${img.length}>>\nstream\n`), img, L("\nendstream\nendobj\n"),
    L(`6 0 obj\n<</Type /XObject /Subtype /Image /Height ${h} /Width ${w} /BitsPerComponent 8 /Filter /FlateDecode /ColorSpace /DeviceGray /Decode [0 1] /Length ${masc.length}>>\nstream\n`), masc, L("\nendstream\nendobj\n"),
    L("trailer\n<< /Size 7 >>\n%%EOF\n")]);
}

// ---------- datos ficticios: planilla de pago anterior del banco ----------
const dv = b => { let s = 0, m = 2; for (let i = b.length - 1; i >= 0; i--) { s += (+b[i]) * m; m = m === 7 ? 2 : m + 1 } const r = 11 - s % 11; return r === 11 ? "0" : r === 10 ? "K" : String(r) };
const R = ["11111111", "22222222", "76543210", "12345678", "9876543"].map(b => b + dv(b));
const T = s => s.join("\t");
const lineas = [
  T(["1", R[0], "COMERCIAL UNO LIMITADA", "uno@ejemplo.cl", "012", "01", "11111111", "64", "150000"]), T(["2", "01092026", "100000", "501", "33", "", "", "", ""]), T(["2", "02092026", "50000", "502", "33", "", "", "", ""]),
  T(["1", R[1], "SERVICIOS DOS SPA", "", "001", "01", "123456789", "64", "90000"]), T(["2", "03092026", "100000", "601", "34", "", "", "", ""]), T(["2", "04092026", "10000", "602", "61", "", "", "", ""]),
  T(["1", R[2], "EDITORIAL TRES LTDA", "tres@ejemplo.cl", "037", "01", "70001234", "64", "250000"]), T(["2", "15082026", "250000", "77", "33", "", "", "", ""]),
];
const planilla = lineas.join("\r\n") + "\r\n";

try {
  // ---------- acceso ----------
  const fuera = await panelEnlace(FUERA);
  await esperar(fuera, () => !document.getElementById("btnSalirAcceso").hidden);
  assert.match(await fuera.textContent("#accesoMsg"), /no tiene acceso/);
  assert.equal(await fuera.isVisible("#app"), false);
  log("usuario fuera de pAllowed(): ve 'sin acceso' y no la app");

  const A = await panel(ADMIN); await listo(A);
  assert.match(await A.textContent("#usuarioRol"), /Administrador/);
  const U = await panelEnlace(USUARIO); await listo(U);
  assert.equal(new URL(U.url()).search, "?emulador"); // se limpia el código del enlace
  log("acceso por enlace al correo: el usuario entra; el de fuera de la lista ve 'sin acceso'");
  assert.doesNotMatch(await U.textContent("#usuarioRol"), /Administrador/);
  log("admin y usuario entran; la sonda detecta al administrador");
  const recursos = await A.evaluate(() => performance.getEntriesByType("resource").map(r => r.name).filter(u => /\/(js|css)\//.test(u)));
  assert.ok(recursos.length >= 15 && recursos.every(u => /\?v=[0-9a-f]{10}$/.test(u)), "hay módulos sin versión: " + recursos.filter(u => !/\?v=/.test(u)).join(", "));
  log("los " + recursos.length + " archivos js/css se cargan con su versión (?v=…), sin copias viejas en caché");

  // ---------- paso 1: pegar planilla anterior del banco ----------
  await A.click('.steps button[data-step="1"]');
  await A.fill("#pasteProv", planilla);
  await A.click("#btnPasteProv");
  await esperar(A, () => document.getElementById("cntProv").textContent === "3");
  await esperar(U, () => document.getElementById("cntProv").textContent === "3" && document.getElementById("cntDocs").textContent === "5/5");
  log("planilla del banco reconstruye 3 proveedores y 5 documentos; el otro usuario lo ve en tiempo real:", await toastTxt(A));

  // ---------- panel de referencia con los mismos datos ----------
  const refCtx = await contexto(); const REF = await refCtx.newPage(); REF.on("dialog", d => d.accept());
  await REF.goto(BASE + "/referencia/panel_actual_claude.html");
  await REF.fill("#pasteProv", planilla); await REF.click("#btnPasteProv");
  const refTxt = await REF.evaluate(() => toTxt(build("GENERAL").lines));

  // ---------- paso 3: generar y comparar byte a byte ----------
  await A.click('.steps button[data-step="3"]');
  await esperar(A, () => !document.getElementById("btnGen").disabled);
  assert.match(await A.textContent("#btnGen"), /N° 1 \(GENERAL\)/);
  const bor = await descarga(A, () => A.click("#btnXlsx"));
  assert.match(bor.nombre, /^\d{8}_PAGO_PROVEEDORES_GENERAL\.xlsx$/);
  const [gen, genXl] = await descargas(A, 2, () => A.click("#btnGen"));
  assert.equal(genXl.nombre, gen.nombre.replace(/\.txt$/, ".xlsx"));
  assert.equal(Buffer.compare(genXl.bytes.subarray(0, 2), Buffer.from("PK")), 0); // es un .xlsx (zip)
  // Ventana de nómina registrada: botones para bajar otra vez cada archivo.
  await esperar(A, () => document.getElementById("dlgGenerada").open);
  assert.match(await A.textContent("#genTitulo"), /Nómina N° 1/);
  const deNuevo = await descarga(A, () => A.click("#genXlsx"));
  assert.equal(deNuevo.nombre, genXl.nombre); assert.equal(Buffer.compare(deNuevo.bytes, genXl.bytes), 0);
  const txtDeNuevo = await descarga(A, () => A.click("#genTxt"));
  assert.equal(Buffer.compare(txtDeNuevo.bytes, gen.bytes), 0);
  await A.screenshot({ path: AQUI + "nomina_generada.png" });
  await A.click("#genCerrar"); await esperar(A, () => !document.getElementById("dlgGenerada").open);
  log("al generar se abre la ventana con Descargar .txt y Descargar Excel BancoEstado (mismos archivos)");
  assert.match(gen.nombre, /_PAGO_PROVEEDORES_GENERAL\.txt$/);
  assert.equal(Buffer.compare(gen.bytes, Buffer.from(refTxt, "utf8")), 0, "el .txt difiere de la referencia");
  writeFileSync(AQUI + "salida_nomina1.txt", gen.bytes);
  log(".txt de la nómina N° 1 idéntico byte a byte al de la referencia (" + gen.bytes.length + " bytes, CRLF)");
  await esperar(A, () => document.querySelector("#hDetail h2")?.textContent.includes("N° 1"));
  await esperar(U, () => document.getElementById("cntDocs").textContent === "0/0");

  // Excel BancoEstado de la nómina: se reimporta como planilla anterior del banco.
  const xl = await descarga(A, () => A.click("#nXlsx"));
  writeFileSync(AQUI + "nomina1.xlsx", xl.bytes);
  const refXl = await REF.evaluate(async () => Array.from(await bankWorkbook(build("GENERAL").lines)));
  log("Excel BancoEstado descargado:", xl.nombre, xl.bytes.length, "bytes (referencia", refXl.length + ")");
  assert.equal(genXl.bytes.length, xl.bytes.length);
  log("al generar se descargan ambos:", gen.nombre, "y", genXl.nombre, "(" + genXl.bytes.length + " bytes, igual al de la bitácora)");

  // ---------- paso 2: documentos con DC y dos usuarios generando a la vez ----------
  await U.click('.steps button[data-step="2"]');
  await U.fill("#pasteDocs", [T([R[0], "10/09/2026", "20000", "900", "33", "SEP", "DC 54"]), T([R[1], "10/09/2026", "30000", "901", "33", "PIE", "DC 55"]), T([R[2], "11/09/2026", "40000", "902", "33", "PIE"])].join("\n"));
  await U.click("#btnPasteDocs");
  await esperar(U, () => document.getElementById("cntDocs").textContent === "3/3");
  assert.match(await U.textContent("#tbDocs"), /DC 54/);
  // documento a mano con DC
  await U.fill("#dRut", R[0]); await U.fill("#dFecha", "2026-09-12"); await U.fill("#dMonto", "5000"); await U.fill("#dNdoc", "903"); await U.selectOption("#dFuente", "SEP"); await U.fill("#dDc", "DC 56");
  await U.click("#btnAddDoc");
  await esperar(U, () => document.getElementById("cntDocs").textContent === "4/4");
  log("documentos pegados y a mano con DC:", await toastTxt(U));
  // Editar un documento pendiente: se carga en el formulario, se corrige y queda en el historial.
  const idDoc = await U.$eval("#tbDocs tr", () => [...document.querySelectorAll("#tbDocs tr")].find(t => t.textContent.includes("903")).querySelector("[data-ed]").dataset.ed);
  await U.click(`#tbDocs [data-ed="${idDoc}"]`);
  assert.match(await U.textContent("#dFormTitulo"), /Editar documento 903/);
  assert.equal(await U.inputValue("#dFecha"), "2026-09-12");
  await U.fill("#dMonto", "5500"); await U.fill("#dDc", "DC 57");
  await U.click("#btnAddDoc");
  // (no se espera el aviso: el del alta anterior puede llegar después y taparlo)
  await esperar(U, () => document.getElementById("dFormTitulo").textContent === "Agregar un documento");
  await esperar(U, () => { const t = [...document.querySelectorAll("#tbDocs tr")].find(t => t.textContent.includes("903")); return t && t.textContent.includes("$5.500") && t.textContent.includes("DC 57") });
  assert.equal(await U.textContent("#dFormTitulo"), "Agregar un documento");
  const hDoc = await U.evaluate(async () => {
    const fs = await import("https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js");
    const q = await fs.getDocs(fs.query(fs.collection(fs.getFirestore(), "pago_historial"), fs.where("accion", "==", "editar documento pendiente")));
    return q.docs.map(d => d.data()).map(h => [h.antes.monto, h.despues.monto, h.antes.dc, h.despues.dc, h.autor]);
  });
  assert.deepEqual(hDoc, [[5000, 5500, "DC 56", "DC 57", USUARIO]]);
  log("editar documento pendiente: se corrige y el historial guarda antes y después");

  await A.click('.steps button[data-step="3"]'); await U.click('.steps button[data-step="3"]');
  await A.click('#tbFuentes tr[data-f="SEP"]'); await U.click('#tbFuentes tr[data-f="PIE"]');
  await esperar(A, () => !document.getElementById("btnGen").disabled); await esperar(U, () => !document.getElementById("btnGen").disabled);
  const [[gA], [gU]] = await Promise.all([descargas(A, 2, () => A.click("#btnGen")), descargas(U, 2, () => U.click("#btnGen"))]).catch(async e => { console.log("toast A:", await toastTxt(A), "| toast U:", await toastTxt(U)); throw e });
  for (const P of [A, U]) { await esperar(P, () => document.getElementById("dlgGenerada").open); await P.click("#genCerrar") }
  await esperar(A, () => document.querySelectorAll("#tbBit tr[data-id]").length === 3);
  const nums = await A.$$eval("#tbBit tr[data-id]", trs => trs.map(t => t.dataset.id).sort());
  assert.deepEqual(nums, ["1", "2", "3"]);
  log("dos usuarios generando a la vez: nóminas", nums.join(", "), "sin repetir número;", gA.nombre, gU.nombre);

  // ---------- paso 4: carga, resultado, rechazo y reintegro ----------
  await A.click('.steps button[data-step="4"]');
  await A.click('#tbBit tr[data-id="1"]');
  // Fecha de pago: por defecto el día hábil siguiente a la carga; no puede ser anterior a la carga.
  // Fechas calculadas desde hoy: un viernes futuro para la carga y su lunes para el pago.
  const iso = d => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  const dmy = d => String(d.getDate()).padStart(2, "0") + "/" + String(d.getMonth() + 1).padStart(2, "0") + "/" + d.getFullYear();
  const vie = new Date(); vie.setDate(vie.getDate() + 1); while (vie.getDay() !== 5) vie.setDate(vie.getDate() + 1);
  const jue = new Date(vie); jue.setDate(vie.getDate() - 1);
  const lun = new Date(vie); lun.setDate(vie.getDate() + 3);
  await A.fill("#nFecha", iso(vie)); await A.dispatchEvent("#nFecha", "change");  // viernes
  assert.equal(await A.inputValue("#nFechaPago"), iso(lun));                       // lunes
  await A.fill("#nFechaPago", iso(jue)); await A.click("#nCargar");
  await esperar(A, () => document.getElementById("toast").textContent.includes("no puede ser anterior"));
  await A.fill("#nFechaPago", iso(lun));
  await A.click("#nCargar");  // sin N° de nómina BancoEstado no se marca como cargada
  await esperar(A, () => document.getElementById("toast").textContent.includes("N° de nómina que asignó BancoEstado"));
  assert.ok((await A.textContent("#hDetail .tag")).includes("Generada"));
  await A.fill("#nOper", "7654321");
  await A.click("#nCargar");
  await esperar(A, () => document.querySelector("#hDetail .tag")?.textContent.includes("Cargada"));
  await esperar(A, () => document.querySelector('#tbBit tr[data-id="1"] td:nth-child(2)').textContent === "7654321");
  assert.ok((await A.textContent("#hDetail h2")).includes("BancoEstado N° 7654321"));
  await A.fill("#hSearch", "7654321");
  await esperar(A, () => document.querySelectorAll("#tbBit tr[data-id]").length === 1 && !!document.querySelector('#tbBit tr[data-id="1"]'));
  await A.fill("#hSearch", "");
  // El mismo N° BancoEstado no se puede usar en otra nómina (el reporte del banco se reparte por ese número).
  await A.click('#tbBit tr[data-id="2"]');
  await esperar(A, () => document.getElementById("hDetail").dataset.id === "2" && !!document.getElementById("nCargar"));
  await A.fill("#nOper", "7654321"); await A.click("#nCargar");
  await esperar(A, () => document.getElementById("toast").textContent.includes("ya es de la nómina N° 1"));
  assert.ok((await A.textContent("#hDetail .tag")).includes("Generada"));
  await A.click('#tbBit tr[data-id="1"]');
  await esperar(A, () => document.getElementById("hDetail").dataset.id === "1" && !document.getElementById("hDetail").hidden);
  log("N° de nómina BancoEstado: obligatorio al cargar, visible en la tabla y en el detalle, y se puede buscar");
  await esperar(A, f => document.querySelector('#tbBit tr[data-id="1"]').textContent.includes(f), dmy(lun));
  assert.ok((await A.textContent("#hDetail .due")).includes("Fecha de pago: " + dmy(lun)));
  log("fecha de pago: sugiere el día hábil siguiente, rechaza fechas anteriores a la carga y se ve en la bitácora");
  assert.ok(new RegExp("Generada el .* por Admin1\\. Cargada en BancoEstado el " + dmy(vie).replace(/\//g, "\\/") + " por Admin1\\.").test(await A.textContent("#hDetail .due")));
  assert.match(await A.textContent('#tbBit tr[data-id="1"]'), /Admin1/);
  assert.ok((await A.textContent("#hDetail .tag")).includes("resultado desde lun " + dmy(lun).slice(0, 5) + " 14:00")); // 14:00 del día de pago
  log("trazabilidad: quién generó y quién cargó; resultado desde las 14:00 del día de pago");
  await A.selectOption('#hDetail [data-pe="1"]', "rechazado");
  await esperar(A, () => document.querySelector('#hDetail [data-pm="1"]'));
  await A.fill('#hDetail [data-pm="1"]', "cuenta inexistente"); await A.press('#hDetail [data-pm="1"]', "Tab");
  await esperar(A, () => document.querySelector('#hDetail [data-pr="1"]'));
  await A.click('#hDetail [data-pr="1"]');
  await esperar(A, () => document.getElementById("cntDocs").textContent === "2/2");
  // Con la tarjeta "Esperando resultado" activa, la nómina pagada sale de la tabla y pasa a "Pagadas".
  await A.click('#bitStats .stat[data-k="espera"]');
  await esperar(A, () => !!document.querySelector('#tbBit tr[data-id="1"]') && !document.getElementById("bitFiltro").hidden);
  await A.click("#nPagarRest");
  await esperar(A, () => /Procesada/.test(document.querySelector("#hDetail .tag")?.textContent));
  await esperar(A, () => !document.querySelector('#tbBit tr[data-id="1"]') && document.getElementById("bitFiltro").textContent.includes("esperando resultado"));
  assert.match(await toastTxt(A), /queda en «Pagadas»/);
  await A.click('#bitStats .stat[data-k="ok"]');
  await esperar(A, () => !!document.querySelector('#tbBit tr[data-id="1"]') && document.querySelector('#bitStats .stat[data-k="ok"] b').textContent === "1");
  const pagadoTarjeta = await A.textContent('#bitStats .stat[data-k="ok"] small');
  await A.click("#bitFiltro [data-vertodas]");
  await esperar(A, () => document.getElementById("bitFiltro").hidden && document.querySelectorAll("#tbBit tr[data-id]").length === 3);
  log("tarjeta Pagadas:", pagadoTarjeta, "; con un filtro activo se avisa y 'Ver todas' vuelve a la lista completa");
  // Reporte de pagos: la nómina 1 se paga el lunes calculado, que puede caer el mes siguiente; "Todo" la incluye.
  await A.click('[data-rper="todo"]');
  await esperar(A, t => document.querySelector("#rKpis .hero b").textContent === t, pagadoTarjeta);
  const rep = await descarga(A, () => A.click("#btnReporte"));
  assert.equal(rep.nombre, "reporte_pagos_todo.xlsx");
  {
    const XLSX = createRequire(import.meta.url)(REPO + "/vendor/xlsx-0.18.5.full.min.js");
    const wb = XLSX.read(rep.bytes, { type: "buffer" });
    assert.deepEqual(wb.SheetNames, ["Resumen", "Pagado", "Rechazados"]);
    const pg = XLSX.utils.sheet_to_json(wb.Sheets.Pagado, { header: 1, raw: true, defval: "" });
    const total = pg.at(-1)[14];
    assert.equal("$" + total.toLocaleString("es-CL"), pagadoTarjeta);
    assert.ok(pg.slice(1, -1).every(f => f[1] === 1 && f[2] === "7654321"));
    const rc = XLSX.utils.sheet_to_json(wb.Sheets.Rechazados, { header: 1, raw: true, defval: "" });
    assert.equal(rc[1][10], "cuenta inexistente");
    const pdf = await descarga(A, () => A.click("#btnReportePdf"));
    assert.equal(pdf.nombre, "reporte_pagos_todo.pdf");
    assert.equal(pdf.bytes.subarray(0, 5).toString("latin1"), "%PDF-");
    assert.ok(pdf.bytes.length > 20000, "PDF de " + pdf.bytes.length + " bytes"); // con el logo
    log("reporte de pagos en PDF:", pdf.nombre, pdf.bytes.length, "bytes");
    log("reporte de pagos:", rep.nombre, "con", pg.length - 2, "documentos pagados por", pagadoTarjeta, "y", rc.length - 2, "rechazo");
  }
  await esperar(A, () => document.querySelectorAll("#nHist li").length >= 5);
  const histN1 = await A.$$eval("#nHist li b", b => b.map(x => x.textContent));
  assert.ok((await A.textContent("#nHist")).includes("fecha de pago " + dmy(lun)));
  log("historial de la nómina 1:", histN1.join(" → "));
  await A.click('.steps button[data-step="2"]');
  assert.match(await A.textContent("#tbDocs"), /Rechazado en nómina N° 1: cuenta inexistente/);
  log("pago rechazado vuelve a pendientes con su motivo");
  // Cerrar el detalle: tocando otra vez la misma nómina o con el botón Cerrar.
  await A.click('.steps button[data-step="4"]');
  await A.click('#tbBit tr[data-id="1"]'); await esperar(A, () => document.getElementById("hDetail").hidden);
  await A.click('#tbBit tr[data-id="1"]'); await esperar(A, () => !document.getElementById("hDetail").hidden);
  await A.click("#nCerrar"); await esperar(A, () => document.getElementById("hDetail").hidden);
  assert.equal(await A.$('#tbBit tr.cur'), null);
  log("detalle de la nómina: se cierra al tocarla de nuevo o con Cerrar");

  // búsqueda por DC en la bitácora
  await A.click('.steps button[data-step="4"]'); await A.fill("#hSearch", "dc 54");
  await esperar(A, () => document.getElementById("hTrace").textContent.includes("DC 54"));
  log("buscador por DC:", (await A.textContent("#hTrace")).slice(0, 120));
  await A.fill("#hSearch", "");

  // ---------- anular y comprobar que queda cerrada ----------
  await A.click('#tbBit tr[data-id="3"]');
  await A.click("#nAnular");
  await esperar(A, () => /Anulada/.test(document.querySelector("#hDetail .tag")?.textContent || "") || document.querySelectorAll('#tbBit tr[data-id="3"]').length === 0);
  await A.check("#hAnul"); await A.click('#tbBit tr[data-id="3"]');
  assert.equal(await A.isDisabled("#nFecha"), true);
  assert.equal(await A.$("#nAnular"), null); assert.equal(await A.$("#nCargar"), null);
  const directo = await A.evaluate(async () => {
    const fs = await import("https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js");
    try { await fs.updateDoc(fs.doc(fs.getFirestore(), "pago_nominas/3"), { obs: "x", updatedBy: "admin1@example.com", updatedAt: fs.serverTimestamp() }); return "escribió" } catch (e) { return e.code }
  });
  assert.equal(directo, "permission-denied");
  log("nómina anulada: sin botones, campos deshabilitados y Firestore rechaza editarla");

  // ---------- cambio de datos bancarios queda en el historial ----------
  await A.click('.steps button[data-step="1"]');
  await A.click(`#tbProv tr[data-rut="${R[0]}"]`);
  await A.fill("#fCuenta", "99990000"); await A.click("#btnSaveProv");
  await esperar(A, () => document.getElementById("toast").textContent.startsWith("Proveedor guardado"));
  await A.click(`#tbProv tr[data-rut="${R[0]}"]`);
  await esperar(A, () => document.getElementById("provHist").textContent.includes("cambio datos bancarios")).catch(async e => { console.log("provHist:", await A.textContent("#provHist"), "| toast:", await toastTxt(A), "| hidden:", await A.$eval("#provHist", x => x.hidden)); throw e });
  log("historial del proveedor:", (await A.textContent("#provHist")).replace(/\s+/g, " ").slice(0, 200));
  // Un usuario no admin no puede cambiar el RUT ni eliminar.
  await U.click('.steps button[data-step="1"]'); await U.click(`#tbProv tr[data-rut="${R[0]}"]`);
  assert.equal(await U.isDisabled("#fRut"), true); assert.equal(await U.isVisible("#btnDelProv"), false);

  // ---------- remuneraciones y abonos (planilla de 7 columnas) ----------
  {
    const { createRequire } = await import("node:module");
    const XLSX = createRequire(import.meta.url)(REPO + "/vendor/xlsx-0.18.5.full.min.js");
    const P = ["33333333", "44444444", "55555555"].map(b => b + dv(b));
    const hoja = XLSX.utils.aoa_to_sheet([["", "", "Pago"], ["", "", "(7 Columnas)"], ["RUT", "NOMBRES Y APELLIDOS O RAZÓN SOCIAL", "EMAIL", "BANCO", "FORMA DE PAGO", "Nº DE CUENTA", "MONTO DEL PAGO"],
      [P[0], "Víctor Núñez Pérez", "FINANZAS@SLEPPETORCA.GOB.CL", "012", "29", "", 151515], [P[1], "maría josé soto", "", "012", "30", "", 42420], [P[2], "PEDRO ROJAS", "", "001", "01", "987654", 25250]]);
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, hoja, "DETALLE");
    const ruta = AQUI + "20260930 - REPOSICION FONDOS FIJOS EE.xlsx";
    writeFileSync(ruta, XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
    await A.click('.steps button[data-step="6"]');
    await A.setInputFiles("#abArchivo", ruta);
    await esperar(A, () => document.querySelectorAll("#abTabla tr .chk").length === 3);
    const tabla = await A.textContent("#abTabla");
    assert.match(tabla, /VICTOR NUNEZ PEREZ/); assert.match(tabla, /MARIA JOSE SOTO/); assert.match(tabla, /FONDOS FIJOS/);
    log("remuneraciones: importa la planilla de 7 columnas, corrige nombres y deduce el concepto:", (await toastTxt(A)).slice(0, 140));
    await A.fill("#abPegar", [P[2], "PEDRO ROJAS", "", "001", "01", "987654", "5000", "PIE", "Viatico octubre"].join("\t")); await A.click("#abBtnPegar");
    await esperar(A, () => document.querySelectorAll("#abTabla tr .chk").length === 4);
    await A.click('#abFuentes tr[data-abf="GENERAL"]');
    await esperar(A, () => !document.getElementById("abBtnGenerar").disabled);
    assert.equal(await A.textContent("#abTotal"), "$219.185");
    const [abTxt, abXl] = await descargas(A, 2, () => A.click("#abBtnGenerar"));
    const hoyA = new Date(); const pref = hoyA.getFullYear() + String(hoyA.getMonth() + 1).padStart(2, "0") + String(hoyA.getDate()).padStart(2, "0");
    assert.equal(abTxt.nombre, pref + "_FONDOS_FIJOS_GENERAL.txt"); assert.equal(abXl.nombre, pref + "_FONDOS_FIJOS_GENERAL.xlsx");
    assert.equal(abTxt.bytes.toString("utf8"), [[P[0], "VICTOR NUNEZ PEREZ", "FINANZAS@SLEPPETORCA.GOB.CL", "012", "29", "", "151515"], [P[1], "MARIA JOSE SOTO", "finanzas@sleppetorca.gob.cl", "012", "30", P[1].slice(0, -1), "42420"], [P[2], "PEDRO ROJAS", "finanzas@sleppetorca.gob.cl", "001", "01", "987654", "25250"]].map(f => f.join("\t")).join("\r\n") + "\r\n");
    const leido = XLSX.read(abXl.bytes, { type: "buffer" });
    assert.equal(leido.SheetNames[0], "DETALLE"); assert.equal(leido.Sheets.DETALLE.B4.v, "VICTOR NUNEZ PEREZ"); assert.equal(leido.Sheets.DETALLE.F4?.v, undefined); // pago cash: cuenta en blanco
    await esperar(A, () => document.getElementById("dlgGenerada").open); await A.click("#genCerrar");
    const nAb = await A.$eval("#hDetail h2", h => h.textContent);
    assert.match(nAb, /remuneraciones \(fondos fijos\)/);
    const idAb = await A.$eval("#hDetail", b => b.dataset.id);
    log("remuneraciones: genera", abTxt.nombre, "y", abXl.nombre, "(7 campos por línea, pago cash sin cuenta y CuentaRUT)");
    // Bitácora: filtro por tipo, carga, rechazo y vuelta a pendientes.
    await A.selectOption("#hTipo", "abonos");
    const filas = await A.$$eval("#tbBit tr[data-id]", t => t.length); assert.equal(filas, 1);
    await A.fill("#nOper", "7654322");
    await A.click("#nCargar");
    await esperar(A, () => document.querySelector("#hDetail .tag")?.textContent.includes("Cargada"));

    // ---------- resultado desde el reporte de BancoEstado ----------
    // Se arma el mismo "Detalle Nómina" que descarga el banco: cabecera con el
    // Nº de nómina y una fila por pago. Aquí solo trae el segundo pago, así que
    // los otros dos siguen pendientes y el resto de la prueba no cambia.
    const XL = createRequire(import.meta.url)(REPO + "/vendor/xlsx-0.18.5.full.min.js");
    const reporteBanco = (oper, filas, total = 42420) => {
      const wb = XL.utils.book_new();
      XL.utils.book_append_sheet(wb, XL.utils.aoa_to_sheet([
        ["Mis Nóminas - Remuneraciones - Ver Nómina"], [], ["Fecha : hoy"], [], ["Detalle Nómina"],
        ["Convenio", "SLEP PRUEBA REMUNERACIONES(REM-1)", "Nº Nómina", oper],
        ["Nombre Nómina", "PRUEBA", "Monto Total $", "$" + total.toLocaleString("es-CL")],
        ["Cantidad Pagos", String(filas.length), "Fecha Pago", "30/09/2026"],
        ["Concepto Pago", "Otros", "Estado Nómina Pagos", "Aceptada"], [],
        ["Rut", "Nombre", "Fecha Abono", "Forma Abono", "Banco", "Código Propio", "N° Cuenta", "Estado Abono", "Motivo", "Monto Abono"],
        ...filas
      ]), "DetalleNomina");
      return Buffer.from(XL.write(wb, { type: "buffer", bookType: "xlsx" }));
    };
    const filaBanco = (rut, nombre, monto, estado, motivo = "") =>
      [rut, nombre, "30/09/2026", "Abono en Cuenta Corriente / Cuenta Vista", "BANCOESTADO", "", "123456", estado, motivo, "$ " + monto.toLocaleString("es-CL")];

    // Un archivo de otra nómina no se aplica: se dice de cuál es.
    await A.setInputFiles("#fReporteBanco", { name: "otra.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: reporteBanco("9999999", [filaBanco(P[1], "MARIA JOSE SOTO", 42420, "Pagado")]) });
    await esperar(A, () => !document.getElementById("cardConciliar").hidden);
    assert.match(await A.textContent("#cardConciliar"), /Ninguna nómina de la bitácora tiene el N° BancoEstado 9999999/);
    assert.equal(await A.$("#concAplicar"), null);            // sin nada que aplicar no hay botón
    // Un monto que no calza con el del banco se avisa y no se toca.
    await A.setInputFiles("#fReporteBanco", { name: "monto.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: reporteBanco("7654322", [filaBanco(P[1], "MARIA JOSE SOTO", 99999, "Pagado")]) });
    await esperar(A, () => document.getElementById("cardConciliar").textContent.includes("$99.999"));
    assert.match(await A.textContent("#cardConciliar"), /\$99\.999.*\$42\.420|\$42\.420.*\$99\.999/s);
    assert.equal(await A.$("#concAplicar"), null);
    // Un estado que el panel no reconoce queda para registrar a mano.
    await A.setInputFiles("#fReporteBanco", { name: "raro.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: reporteBanco("7654322", [filaBanco(P[1], "MARIA JOSE SOTO", 42420, "En Proceso")]) });
    await esperar(A, () => document.getElementById("cardConciliar").textContent.includes("En Proceso"));
    assert.equal(await A.$("#concAplicar"), null);
    // El archivo correcto: vista previa con el cambio, y se aplica.
    await A.setInputFiles("#fReporteBanco", { name: "bueno.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: reporteBanco("7654322", [filaBanco(P[1], "MARIA JOSE SOTO", 42420, "Pagado")]) });
    await esperar(A, () => !!document.getElementById("concAplicar"));
    assert.match(await A.textContent("#concAplicar"), /Registrar 1 resultado$/);
    assert.match(await A.textContent("#cardConciliar"), /no lo informa/);          // los otros dos pagos
    await A.screenshot({ path: AQUI + "reporte_banco.png", fullPage: false });
    await A.click("#concCancelar");                                                // cancelar no escribe nada
    await esperar(A, () => document.getElementById("cardConciliar").hidden);
    assert.equal(await A.$eval('#hDetail [data-pe="1"]', s => s.value), "pendiente");
    await A.setInputFiles("#fReporteBanco", { name: "bueno.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: reporteBanco("7654322", [filaBanco(P[1], "MARIA JOSE SOTO", 42420, "Pagado")]) });
    await esperar(A, () => !!document.getElementById("concAplicar"));
    await A.click("#concAplicar");
    await esperar(A, () => document.getElementById("cardConciliar").hidden);
    await esperar(A, () => document.querySelector('#hDetail [data-pe="1"]')?.value === "pagado");
    assert.match(await toastTxt(A), /1 resultado registrado desde el reporte del banco/);
    // Volver a subirlo no vuelve a escribir: el pago ya quedó registrado así.
    await A.setInputFiles("#fReporteBanco", { name: "bueno.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: reporteBanco("7654322", [filaBanco(P[1], "MARIA JOSE SOTO", 42420, "Pagado")]) });
    await esperar(A, () => !document.getElementById("cardConciliar").hidden);
    assert.equal(await A.$("#concAplicar"), null);
    assert.match(await A.textContent("#cardConciliar"), /ya estaba registrado así/);
    await A.click("#concCerrar");
    const hBanco = await A.evaluate(async () => {
      const fs = await import("https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js");
      const q = await fs.getDocs(fs.query(fs.collection(fs.getFirestore(), "pago_historial"), fs.where("accion", "==", "resultado del banco")));
      return q.docs.map(d => d.data().detalle);
    });
    assert.equal(hBanco.length, 1);
    assert.match(hBanco[0], /archivo bueno\.xlsx: 1 pagado \(\$42\.420\)/);
    log("reporte del banco: rechaza el archivo de otra nómina, avisa montos y estados que no calzan, la vista previa no escribe y al aplicar queda en el historial");

    await A.selectOption('#hDetail [data-pe="2"]', "rechazado");
    await esperar(A, () => document.querySelector('#hDetail [data-pr="2"]'));
    await A.click('#hDetail [data-pr="2"]');
    await esperar(A, () => document.getElementById("cntAbonos").textContent === "2/2");
    await A.selectOption("#hTipo", "*");
    await A.click('.steps button[data-step="6"]');
    assert.match(await A.textContent("#abTabla"), /Rechazado en nómina N° \d+/);
    // Alta manual: el RUT ya pagado autocompleta sus datos.
    await A.fill("#abRut", P[0]); await A.dispatchEvent("#abRut", "change");
    assert.equal(await A.inputValue("#abNombre"), "VICTOR NUNEZ PEREZ"); assert.equal(await A.inputValue("#abForma"), "29");
    log("remuneraciones: rechazo vuelve a la pestaña, filtro por tipo en la bitácora y autocompletar desde el último pago");
    // Editar un abono pendiente: el formulario se carga, se guarda y queda en el historial.
    await A.click("#abBtnCancelar").catch(() => {});
    const primero = await A.$eval("#abTabla [data-abed]", b => b.dataset.abed);
    await A.click(`#abTabla [data-abed="${primero}"]`);
    assert.match(await A.textContent("#abFormTitulo"), /Editar abono/);
    await A.fill("#abMonto", "33333"); await A.selectOption("#abBanco", "012"); await A.selectOption("#abForma", "29");
    await A.click("#abBtnAgregar");
    await esperar(A, () => document.getElementById("abFormTitulo").textContent === "Agregar un abono");
    await esperar(A, () => document.getElementById("abTabla").textContent.includes("$33.333") && document.getElementById("abTabla").textContent.includes("sin cuenta"));
    assert.equal(await A.textContent("#abFormTitulo"), "Agregar un abono");
    const hEd = await A.evaluate(async () => {
      const fs = await import("https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js");
      const q = await fs.getDocs(fs.query(fs.collection(fs.getFirestore(), "pago_historial"), fs.where("accion", "==", "cambio datos bancarios abono")));
      return q.docs.map(d => d.data()).map(h => [h.antes.forma, h.despues.forma, h.despues.monto]);
    });
    assert.deepEqual(hEd, [["01", "29", 33333]]);
    log("remuneraciones: editar un abono pendiente; el cambio de banco/forma queda en el historial con antes y después");
    // Pago cash (forma 29): pagado por el banco, pero pendiente de cobro hasta que se retira.
    await A.click('.steps button[data-step="4"]');
    if (await A.$eval("#hDetail", (b, id) => b.hidden || b.dataset.id !== id, idAb)) await A.click(`#tbBit tr[data-id="${idAb}"]`); // tocarla abierta la cierra
    await esperar(A, id => !document.getElementById("hDetail").hidden && document.getElementById("hDetail").dataset.id === id && !!document.getElementById("nPagarRest"), idAb);
    await A.click("#nPagarRest");
    await esperar(A, () => document.querySelector("#hDetail .tag")?.textContent === "Pagada, 1 por cobrar en banco");
    assert.match(await toastTxt(A), /queda en «Por cobrar en banco»/);
    assert.equal(await A.$$eval("#hDetail [data-co]", s => s.length), 1); // solo el pago cash
    assert.equal(await A.textContent('#bitStats .stat[data-k="cobro"] small'), "$151.515");
    assert.ok((await A.textContent("#hDetail .due")).includes("por cobrar en banco $151.515"));
    await A.selectOption('#hDetail [data-co="0"]', "cobrado");
    await esperar(A, () => /Procesada, 1 rechazo$/.test(document.querySelector("#hDetail .tag")?.textContent) && !!document.querySelector('#hDetail [data-cf="0"]'));
    assert.equal(await A.inputValue('#hDetail [data-cf="0"]'), iso(new Date()));
    assert.ok(await A.$eval('#hDetail [data-pe="0"]', s => s.disabled)); // con cobro registrado no se cambia el resultado
    await A.selectOption('#hDetail [data-co="0"]', "devuelto");
    await esperar(A, () => /^Procesada, 1 por reintegrar$/.test(document.querySelector("#hDetail .tag")?.textContent) && !!document.querySelector('#hDetail [data-pr="0"]'));
    await A.click('#hDetail [data-pr="0"]');
    await esperar(A, () => document.getElementById("cntAbonos").textContent === "3/3" && /Procesada, 1 rechazo, 1 no cobrado$/.test(document.querySelector("#hDetail .tag")?.textContent));
    const histCobro = await A.$$eval("#nHist li b", b => b.map(x => x.textContent));
    assert.deepEqual(histCobro.filter(h => /cobro|no cobrado/.test(h)), ["cobro en banco", "cobro en banco", "reintegrar pago no cobrado"]);
    await A.click('.steps button[data-step="6"]');
    assert.match(await A.textContent("#abTabla"), /No cobrado en banco en nómina N° \d+/);
    log("pago cash: pendiente de cobro → cobrado → no cobrado; vuelve a Remuneraciones para pagarlo de nuevo");
    assert.match(await A.textContent("#p6 [data-estado=s]"), /abonos? marcados?/);
    const navOk = await A.evaluate(() => { const n = document.querySelector(".steps"); return n.scrollWidth <= n.clientWidth + 1 });
    assert.ok(navOk, "las pestañas no caben en 1280 px");
    await A.screenshot({ path: AQUI + "remuneraciones.png", fullPage: true });

    // ---------- transferencias electrónicas (pago directo, sin nómina) ----------
    // Cuenta de origen asociada a su fuente en Configuración.
    await A.click("#btnConfig");
    await A.fill("#cCuentaNum", "1110-0000001"); await A.fill("#cCuentaNom", "Subvencion SEP"); await A.selectOption("#cCuentaFuente", "SEP");
    await A.click("#btnAddCuenta");
    await esperar(A, () => document.getElementById("tbCuentas").textContent.includes("11100000001"));
    await A.click("#btnConfig");
    await A.click('.steps button[data-step="4"]');
    const pendDocs = await A.evaluate(async () => {
      const fs = await import("https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js");
      const q = await fs.getDocs(fs.collection(fs.getFirestore(), "pago_documentos"));
      return q.docs.map(d => d.data()).map(d => ({ rut: d.rut, monto: d.monto, tipo: d.tipo, ndoc: d.ndoc }));
    });
    const rutDoc = pendDocs[0].rut, docsRut = pendDocs.filter(d => d.rut === rutDoc);
    const sumaDocs = docsRut.reduce((a, d) => a + (["60", "61"].includes(d.tipo) ? -d.monto : d.monto), 0);
    const cntDocsAntes = await A.textContent("#cntDocs");
    // 1) Paga documentos pendientes del paso 2.
    await A.click("#btnTef");
    await esperar(A, () => document.getElementById("dlgTef").open);
    await A.click("#tManual"); // sin PDF: el formulario completo
    await A.fill("#tNum", "900001"); await A.fill("#tIdTef", "5550001111"); await A.fill("#tHora", "16:48");
    await A.selectOption("#tCuenta", "11100000001");
    assert.equal(await A.inputValue("#tFuente"), "SEP"); // la fuente sale de la cuenta
    await A.fill("#tRut", rutDoc); await A.dispatchEvent("#tRut", "change");
    assert.notEqual(await A.inputValue("#tNombre"), ""); // desde el maestro de proveedores
    await A.click('#tOrigen [data-origen="documentos"]');
    await esperar(A, n => document.querySelectorAll("#tItems input").length === n, docsRut.length);
    for (const c of await A.$$("#tItems input")) await c.check();
    await A.fill("#tMonto", String(sumaDocs)); await A.dispatchEvent("#tMonto", "change");
    assert.match(await A.textContent("#tSuma"), /calza con el monto/);
    await A.fill("#tConcepto", "PAGO FACTURAS"); await A.fill("#tMensaje", "MEMO 1"); await A.fill("#tPreparo", "Usuario1"); await A.fill("#tAutorizo", "Admin1");
    await A.click("#tRegistrar");
    await esperar(A, () => !document.getElementById("dlgTef").open && /^Transferencia N° 900001/.test(document.querySelector("#hDetail h2")?.textContent || ""));
    assert.equal(await A.textContent("#hDetail .tag"), "Transferencia pagada");
    const numTef = await A.$eval("#hDetail", b => b.dataset.id);
    await esperar(A, (id, n) => document.querySelector(`#tbBit tr[data-id="${id}"] td:nth-child(2)`)?.textContent === "900001" && document.getElementById("cntDocs").textContent !== n, numTef, cntDocsAntes);
    assert.ok((await A.textContent("#hDetail .due")).includes("desde la cuenta 11100000001 (Subvencion SEP). ID TEF 5550001111."));
    // El documento pagado por transferencia aparece en la trazabilidad del buscador.
    await A.fill("#hSearch", docsRut[0].ndoc);
    await esperar(A, (id) => [...document.querySelectorAll("#hTrace a")].some(a => a.dataset.go === id), numTef);
    await A.fill("#hSearch", "");
    log("transferencia N° 900001: paga", docsRut.length, "documentos pendientes por $" + sumaDocs.toLocaleString("es-CL"), "(registro N°", numTef + "); fuente desde la cuenta de origen");
    // 2) Un N° de transferencia no se registra dos veces.
    await A.click("#btnTef"); await A.click("#tManual");
    await A.fill("#tNum", "900001"); await A.selectOption("#tCuenta", "11100000001");
    await A.fill("#tRut", P[2]); await A.dispatchEvent("#tRut", "change"); await A.fill("#tNombre", "OTRO"); await A.fill("#tMonto", "5"); await A.fill("#tConcepto", "X");
    await A.click("#tRegistrar");
    await esperar(A, () => document.getElementById("toast").textContent.includes("ya está registrada"));
    assert.equal(await A.evaluate(() => document.getElementById("toast").parentElement.id), "dlgTef"); // el aviso se ve sobre el diálogo
    // 3) Pago sin documento en el panel, desde otra cuenta; después se anula (registrado por error).
    await A.fill("#tNum", "900002"); await A.selectOption("#tCuenta", "__otra"); await A.fill("#tCuentaOtra", "11100000002"); await A.selectOption("#tFuente", "GENERAL");
    const rutSuelto = "77777777" + dv("77777777");
    await A.fill("#tRut", rutSuelto); await A.dispatchEvent("#tRut", "change"); await A.fill("#tNombre", "EMPRESA SANITARIA DE PRUEBA");
    await A.fill("#tMonto", "1000000"); await A.fill("#tConcepto", "AGUA EE"); await A.fill("#tMensaje", "MEMO 12");
    await A.click("#tRegistrar");
    await esperar(A, () => /^Transferencia N° 900002/.test(document.querySelector("#hDetail h2")?.textContent || ""));
    assert.equal(await A.$('#hDetail [data-pr]'), null);
    await A.fill("#tObsD", "comprobante en carpeta"); await A.click("#tGuardar");
    await esperar(A, () => document.getElementById("toast").textContent === "Cambios guardados");
    await A.click("#tAnular");
    await esperar(A, () => document.querySelector("#hDetail .tag")?.textContent === "Anulada");
    // 4) Paga un abono pendiente de Remuneraciones (el no cobrado que volvió a la pestaña).
    const cntAbAntes = await A.textContent("#cntAbonos");
    await A.click("#btnTef"); await A.click("#tManual");
    await A.fill("#tNum", "900003"); await A.selectOption("#tCuenta", "11100000001");
    await A.fill("#tRut", P[0]); await A.dispatchEvent("#tRut", "change");
    assert.equal(await A.inputValue("#tNombre"), "VICTOR NUNEZ PEREZ");
    await A.click('#tOrigen [data-origen="abonos"]');
    await A.fill("#tMonto", "151515"); await A.dispatchEvent("#tMonto", "change");
    await A.click('#tOrigen [data-origen="abonos"]'); // vuelve a listar con el monto: el abono que calza queda marcado
    await esperar(A, () => [...document.querySelectorAll("#tItems input")].some(i => i.checked));
    await A.fill("#tConcepto", "REPOSICION FONDO FIJO");
    await A.click("#tRegistrar");
    await esperar(A, n => /^Transferencia N° 900003/.test(document.querySelector("#hDetail h2")?.textContent || "") && document.getElementById("cntAbonos").textContent !== n, cntAbAntes);
    // Filtro por tipo y reporte de pagos solo de transferencias (la anulada no cuenta).
    await A.selectOption("#hTipo", "transferencia"); await A.check("#hAnul");
    assert.equal(await A.$$eval("#tbBit tr[data-id]", t => t.length), 3);
    await A.uncheck("#hAnul");
    assert.equal(await A.$$eval("#tbBit tr[data-id]", t => t.length), 2);
    await A.selectOption("#hTipo", "*");
    await A.click('[data-rper="todo"]'); await A.selectOption("#rTipo", "transferencia");
    await esperar(A, t => document.querySelector("#rKpis .hero b").textContent === t, "$" + (sumaDocs + 151515).toLocaleString("es-CL"));
    const repTef = await descarga(A, () => A.click("#btnReporte"));
    {
      const XLSX = createRequire(import.meta.url)(REPO + "/vendor/xlsx-0.18.5.full.min.js");
      const pg = XLSX.utils.sheet_to_json(XLSX.read(repTef.bytes, { type: "buffer" }).Sheets.Pagado, { header: 1, raw: true, defval: "" });
      assert.deepEqual([...new Set(pg.slice(1, -1).map(f => f[3]))], ["Transferencias"]);
      assert.deepEqual([...new Set(pg.slice(1, -1).map(f => f[2]))].sort(), ["900001", "900003"]);
    }
    await A.selectOption("#rTipo", "*");
    log("transferencias: pago sin documento anulado, abono de Remuneraciones pagado, filtro por tipo y reporte solo de transferencias");

    // 5) Desde el PDF de BancoEstado: el panel lee el comprobante con OCR.
    // El PDF se arma aquí con datos ficticios y la estructura del banco: una
    // captura de la página (RGB con Flate) y su máscara de transparencia.
    const docsPdf = (await A.evaluate(async () => {
      const fs = await import("https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js");
      const q = await fs.getDocs(fs.collection(fs.getFirestore(), "pago_documentos"));
      return q.docs.map(d => d.data()).map(d => ({ rut: d.rut, monto: d.monto, tipo: d.tipo }));
    }));
    const rutPdf = docsPdf.length ? docsPdf[0].rut : null, fmtR = r => r.slice(0, -1).replace(/\B(?=(\d{3})+(?!\d))/g, ".") + "-" + r.slice(-1);
    const sumaPdf = docsPdf.filter(d => d.rut === rutPdf).reduce((a, d) => a + (["60", "61"].includes(d.tipo) ? -d.monto : d.monto), 0);
    const tef1 = await pdfTransferencia({ num: "9100011", idTef: "5550002222", hora: "11:20", cuenta: "11100000001", cuentaNombre: "Subvencion SEP", alias: "SANITARIA DE PRUEBA", nombre: "EMPRESA SANITARIA DE PRUEBA", rut: fmtR(rutSuelto), cuentaB: "000000098765432100", monto: 432100, concepto: "AGUA ESCUELA", mensaje: "MEMO 77" });
    const tef2 = rutPdf && await pdfTransferencia({ num: "9100012", idTef: "5550003333", hora: "11:25", cuenta: "11100000009", cuentaNombre: "Subvencion General", alias: "PROVEEDOR", nombre: "PROVEEDOR DE PRUEBA", rut: fmtR(rutPdf), cuentaB: "000000000012345678", monto: sumaPdf, concepto: "PAGO FACTURAS", mensaje: "MEMO 78" });
    await A.click("#btnTef");
    await A.setInputFiles("#tPdf", [
      { name: "DetalleTransferenciaElectronica_prueba_1.pdf", mimeType: "application/pdf", buffer: tef1 },
      ...(tef2 ? [{ name: "DetalleTransferenciaElectronica_prueba_2.pdf", mimeType: "application/pdf", buffer: tef2 }] : []),
      { name: "ComprobanteTransferenciaElectronica_prueba_1.pdf", mimeType: "application/pdf", buffer: tef1 } // la misma transferencia otra vez
    ]);
    await A.waitForFunction(() => !document.getElementById("tResumen").hidden && document.getElementById("tNum").value === "9100011", null, { timeout: 120000 });
    assert.equal(await A.inputValue("#tRut"), fmtR(rutSuelto));
    assert.equal(await A.inputValue("#tMonto"), "432.100");
    assert.equal(await A.inputValue("#tIdTef"), "5550002222");
    assert.equal(await A.inputValue("#tHora"), "11:20");
    assert.equal(await A.inputValue("#tCuenta"), "11100000001");
    assert.equal(await A.inputValue("#tFuente"), "SEP"); // cuenta asociada en Configuración
    assert.equal(await A.inputValue("#tBanco"), "012");
    assert.equal(await A.inputValue("#tCuentaB"), "98765432100");
    assert.equal(await A.inputValue("#tConcepto"), "AGUA ESCUELA");
    assert.equal(await A.inputValue("#tPreparo"), "Usuario Uno");
    assert.equal(await A.inputValue("#tAutorizo"), "Administrador Uno, Usuario Dos");
    assert.equal(await A.getAttribute('#tOrigen [data-origen="suelto"]', "aria-pressed"), "true");
    assert.equal(await A.isVisible("#tCampos"), false); // sin dudas del OCR: solo el resumen
    assert.match(await A.textContent("#tResDatos"), /\$432\.100/);
    await A.screenshot({ path: AQUI + "transferencia-pdf.png" });
    await A.click("#tRegistrar");
    if (tef2) {
      await A.waitForFunction(() => document.getElementById("tNum").value === "9100012", null, { timeout: 60000 });
      assert.equal(await A.inputValue("#tCuenta"), "__otra");
      assert.equal(await A.inputValue("#tCuentaOtra"), "11100000009");
      assert.equal(await A.inputValue("#tFuente"), "GENERAL"); // del nombre de la cuenta
      assert.match(await A.textContent("#tAvisos"), /no está asociada a una fuente/);
      assert.equal(await A.getAttribute('#tOrigen [data-origen="documentos"]', "aria-pressed"), "true");
      await esperar(A, () => /calza con el monto/.test(document.getElementById("tSuma").textContent));
      await A.click("#tRegistrar");
    }
    // El tercer PDF es la misma transferencia: no se registra dos veces.
    await esperar(A, () => document.querySelector("#tCola li.repetida") && document.getElementById("tAcciones").hidden);
    assert.match(await A.textContent("#tCola"), /registrada \(registro N° \d+\)/);
    await A.screenshot({ path: AQUI + "transferencia-pdf-cola.png" });
    await A.click("#tefCerrar");
    await esperar(A, () => [...document.querySelectorAll("#tbBit tr[data-id] td:nth-child(2)")].some(td => td.textContent === "9100011"));
    if (tef2) await esperar(A, () => [...document.querySelectorAll("#tbBit tr[data-id] td:nth-child(2)")].some(td => td.textContent === "9100012"));
    log("transferencias desde PDF:", tef2 ? "2 registradas (una sin documento, otra paga " + docsPdf.filter(d => d.rut === rutPdf).length + " documentos que calzan con el monto)" : "1 registrada", "y el PDF repetido se informa");
  }

  // ---------- Detalle de Nómina del banco por documento (Excel), en el paso 2 ----------
  {
    const XLSX = createRequire(import.meta.url)(REPO + "/vendor/xlsx-0.18.5.full.min.js");
    const fmt = r => r.slice(0, -1).replace(/\B(?=(\d{3})+(?!\d))/g, ".") + "-" + r.slice(-1);
    const fila = (ndoc, tipo, monto) => [fmt(R[0]), "COMERCIAL UNO LIMITADA  ", "", "Abono en Cuenta Corriente / Cuenta Vista", "BANCO DEL ESTADO DE CHILE", "$ 1.500", "Aceptado en validación", "", ndoc, tipo, "31/08/2026", monto];
    const ws = XLSX.utils.aoa_to_sheet([["Mis Nóminas - Ver Nómina - Ver Documento"], [], ["Fecha : Oct 5, 2026, 11:44:28 AM"], [], ["Detalle Nómina"],
      ["Convenio", "SLEP EJEMPLO PROVEEDORES(PROV-000)", "Nº Nómina", 900100], ["Nombre Nómina", "P02_EJEMPLO_FAEP", "Monto Total $", "$1.500"],
      ["Cantidad Pagos", "1", "Fecha Pago", "05/10/2026"], ["Concepto Pago", "Proveedores", "Estado Nómina Pagos", "Provisión Autorizada"], [],
      ["Rut", "Nombre", "Centro Negocio", "Tipo Abono", "Banco", "Monto Total $", "Estado", "Motivo", "N° Documento", "Tipo Documento", "Fecha Emisión", "Monto $"],
      fila(8001, "FACTURA ELECTRONICA", "$ 1.000"), fila(8002, "FACTURA NO AFECTA O EXENTA ELECTRONICA", "$ 500")]);
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "DetalleNomina");
    const archivo = { name: "Detalle_Nomina_N__900100_-_prueba.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from(XLSX.write(wb, { type: "array", bookType: "xlsx" })) };
    const docsBanco = () => A.evaluate(async () => {
      const fs = await import("https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js");
      const q = await fs.getDocs(fs.collection(fs.getFirestore(), "pago_documentos"));
      return q.docs.map(d => ({ id: d.id, ...d.data() })).filter(d => ["8001", "8002"].includes(d.ndoc)).map(d => ({ id: d.id, ndoc: d.ndoc, tipo: d.tipo, monto: d.monto, fuente: d.fuente })).sort((x, y) => x.ndoc.localeCompare(y.ndoc));
    });
    await A.click('.steps button[data-step="2"]');
    await A.setInputFiles("#fileDocs", archivo);
    await esperar(A, () => /Agregado: 2 documentos \(FAEP 2\)/.test(document.getElementById("toast").textContent));
    let enFs = await docsBanco();
    assert.deepEqual(enFs.map(d => [d.ndoc, d.tipo, d.monto, d.fuente]), [["8001", "33", 1000, "FAEP"], ["8002", "34", 500, "FAEP"]]);
    // Uno quedó sin tipo (como al importarlo antes de esta corrección): al subirlo de nuevo se completa y nada se duplica.
    await A.evaluate(async id => {
      const fs = await import("https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js");
      await fs.updateDoc(fs.doc(fs.getFirestore(), "pago_documentos", id), { tipo: "", updatedBy: "admin1@example.com", updatedAt: fs.serverTimestamp() });
    }, enFs[0].id);
    await A.setInputFiles("#fileDocs", archivo);
    await esperar(A, () => /1 pendiente con el tipo de documento corregido\. 1 ya estaba pendiente y no se duplicó/.test(document.getElementById("toast").textContent));
    enFs = await docsBanco();
    assert.deepEqual(enFs.map(d => [d.ndoc, d.tipo]), [["8001", "33"], ["8002", "34"]]);
    log("Detalle de Nómina del banco por documento: tipo en texto → código, monto de cada documento, fuente desde el nombre de la nómina, sin duplicar y corrige el tipo vacío");
  }

  // ---------- feriados ----------
  await A.click("#btnConfig");
  await A.fill("#cFeriado", "18/09/2026, 2026-09-19"); await A.click("#btnAddFeriado");
  await esperar(A, () => document.getElementById("feriados").textContent.includes("18/09/2026"));
  log("feriados:", await A.textContent("#feriados"));

  // ---------- migración desde el panel de referencia ----------
  // En la referencia: generar una nómina y marcarla cargada, para tener bitácora.
  await REF.click('.steps button[data-step="3"]'); await REF.click("#btnGen");
  await REF.evaluate(() => { nominas[0].estado = "cargada"; nominas[0].fechaCarga = "2026-09-20"; nominas[0].pagos[0].estado = "pagado"; saveNom() });
  await REF.click('.steps button[data-step="2"]');
  await REF.fill("#pasteDocs", T([R[0], "20/09/2026", "7000", "990", "33", "SEP"])); await REF.click("#btnPasteDocs");
  await REF.click('.steps button[data-step="3"]'); await REF.click('#tbFuentes tr[data-f="SEP"]'); await REF.click("#btnGen");
  await REF.click('.steps button[data-step="2"]');
  await REF.fill("#pasteDocs", [T([R[0], "20/09/2026", "", "991", "33", "SEP"]), T([R[1], "21/09/2026", "8000", "992", "33", "PIE"])].join("\n")); await REF.click("#btnPasteDocs");
  const respaldo = await REF.evaluate(() => { const o = {}; for (const k of ["bepago.maestro.v1", "bepago.docs.v1", "bepago.nominas.v1", "bepago.config.v1"]) o[k] = localStorage.getItem(k); return o });
  writeFileSync(AQUI + "respaldo_ref.json", JSON.stringify(respaldo));
  const refNoms = JSON.parse(respaldo["bepago.nominas.v1"]);
  log("respaldo de la referencia:", refNoms.length, "nóminas,", JSON.parse(respaldo["bepago.docs.v1"]).length, "documentos pendientes");

  await limpiarFirestore();
  await A.reload(); await A.waitForFunction(() => window.__entrarEmulador); await listo(A);
  if (!(await A.isVisible("#p5"))) await A.click("#btnConfig"); // al recargar vuelve al último paso abierto
  assert.equal(await A.isVisible("#cardMigracion"), true);
  await A.setInputFiles("#fileRespaldo", AQUI + "respaldo_ref.json");
  await esperar(A, () => document.getElementById("btnConfirmarRespaldo"));
  log("resumen previo:", (await A.textContent("#resumenRespaldo")).replace(/\s+/g, " ").slice(0, 400));
  await A.click("#btnConfirmarRespaldo");
  await esperar(A, () => document.getElementById("avanceRespaldo")?.textContent === "Importación terminada.");
  await A.click('.steps button[data-step="4"]'); await A.check("#hAnul");
  await esperar(A, (n) => document.querySelectorAll("#tbBit tr[data-id]").length === n, refNoms.length);
  const estados = await A.$$eval("#tbBit tr[data-id] .tag", t => t.map(x => x.textContent));
  log("nóminas migradas:", estados.join(" | "), "· documentos pendientes:", await A.textContent("#cntDocs"));
  assert.equal(await A.textContent("#cntProv"), "3");
  // El .txt de la nómina migrada es el mismo que generó la referencia.
  await A.click('#tbBit tr[data-id="1"]');
  const mig = await descarga(A, () => A.click("#nTxt"));
  const refN1 = await REF.evaluate(() => toTxt(nominas[0].lines));
  assert.equal(Buffer.compare(mig.bytes, Buffer.from(refN1, "utf8")), 0);
  await A.click('.steps button[data-step="3"]');
  assert.match(await A.textContent("#btnGen"), new RegExp("N° " + (refNoms.length + 1)));
  log("nómina migrada idéntica y el contador sigue en", refNoms.length + 1);

  // ---------- capturas ----------
  await A.click('.steps button[data-step="4"]'); await A.click('#tbBit tr[data-id="1"]');
  await A.click('[data-tema="light"]');
  // Guía "Cómo se usa": abre en la sección del paso actual y se cierra.
  await A.click('.steps button[data-step="3"]');
  await A.click("#btnGuia");
  await esperar(A, () => document.getElementById("guia").open);
  assert.equal(await A.getAttribute('#guiaIndice a[data-sec="p3"]', "aria-current"), "true");
  assert.equal(await A.$eval('.steps button[data-step="3"]', b => b.getAttribute("aria-selected")), "true"); // el botón no cambia de paso
  await A.screenshot({ path: AQUI + "guia.png" });
  await A.click('#guiaIndice a[data-sec="faq"]');
  await esperar(A, () => document.querySelector('#guiaIndice a[data-sec="faq"]').getAttribute("aria-current") === "true");
  await A.click("#guiaCerrar");
  await esperar(A, () => !document.getElementById("guia").open);
  log("guía Cómo se usa: abre en el paso actual, navega por secciones y se cierra");
  await A.screenshot({ path: AQUI + "escritorio_paso4.png", fullPage: true });
  await A.click('.steps button[data-step="3"]'); await A.screenshot({ path: AQUI + "escritorio_paso3.png", fullPage: true });
  await A.click('[data-tema="dark"]');
  assert.equal(await A.evaluate(() => document.documentElement.dataset.theme), "dark");
  await A.screenshot({ path: AQUI + "escritorio_paso3_oscuro.png", fullPage: true });
  await A.click('.steps button[data-step="4"]'); await A.screenshot({ path: AQUI + "escritorio_paso4_oscuro.png", fullPage: true });
  await A.reload(); await listo(A);
  assert.equal(await A.evaluate(() => document.documentElement.dataset.theme), "dark"); // se recuerda al recargar
  await A.click('[data-tema="system"]');
  assert.equal(await A.evaluate(() => document.documentElement.dataset.theme), undefined);
  log("tema claro/oscuro/sistema: cambia, se recuerda al recargar y vuelve al del sistema");
  await A.click('.steps button[data-step="4"]');
  const M = await panel(USUARIO, true); await listo(M);
  await M.screenshot({ path: AQUI + "movil_paso1.png", fullPage: false });
  await M.click("#btnGuia"); await esperar(M, () => document.getElementById("guia").open);
  await M.screenshot({ path: AQUI + "movil_guia.png" }); await M.click("#guiaCerrar");
  await M.click('.steps button[data-step="2"]'); await M.screenshot({ path: AQUI + "movil_paso2.png", fullPage: false });
  await M.click('.steps button[data-step="3"]'); await M.screenshot({ path: AQUI + "movil_paso3.png", fullPage: false });
  const ancho = await M.evaluate(() => document.documentElement.scrollWidth);
  log("móvil: ancho de página", ancho, "px (viewport 390)");
  log("TODO OK");
} catch (e) {
  console.error("FALLÓ:", e);
  process.exitCode = 1;
} finally {
  await browser.close(); srv.kill();
}
