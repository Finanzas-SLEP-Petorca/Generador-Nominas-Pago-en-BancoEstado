// Compara el panel nuevo con el de referencia usando el código de la propia
// referencia (referencia/panel_actual_claude.html), ejecutado en un sandbox.
// Verifica que el .txt sea idéntico byte a byte y que las validaciones, la
// ingestión y la planilla del banco den lo mismo.
//   node tests/formato.test.mjs
import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const F = await import(path.join(raiz, "js/formato.js"));
const I = await import(path.join(raiz, "js/importar.js"));
const C = await import(path.join(raiz, "js/catalogos.js"));

// ---------- cargar la lógica de la referencia ----------
const html = readFileSync(path.join(raiz, "referencia/panel_actual_claude.html"), "utf8");
const script = html.slice(html.indexOf("<script>\n") + 9, html.lastIndexOf("</script>"));
const logica = script.slice(0, script.indexOf("// ---------- UI ----------"));
const extraer = nombre => { const i = script.indexOf("function " + nombre + "("); const j = script.indexOf("\n}\n", i); return script.slice(i, j + 3) };
const unaLinea = nombre => { const i = script.indexOf("function " + nombre + "("); return script.slice(i, script.indexOf("\n", i)) };
const ctx = vm.createContext({ console });
vm.runInContext(logica + "\n" + extraer("activeIndex") + "\n" + extraer("nomStatus") + "\n" + unaLinea("resultDue") + "\n" + unaLinea("fmtDue") + "\nconst DIAS=[\"dom\",\"lun\",\"mar\",\"mié\",\"jue\",\"vie\",\"sáb\"];", ctx);
const ref = code => vm.runInContext(code, ctx);
const setRef = (k, v) => { ctx.__v = JSON.parse(JSON.stringify(v)); ref(`${k}=__v`) };

let pruebas = 0;
const ok = (nombre, fn) => { fn(); pruebas++; console.log("  ✓ " + nombre) };

// ---------- catálogos ----------
ok("catálogos idénticos", () => {
  for (const k of ["BANCOS", "FORMAS", "SECTORES", "TIPOS"]) assert.deepEqual(C[k], JSON.parse(JSON.stringify(ref(k))), k);
});

// ---------- datos de prueba ficticios y reproducibles ----------
let semilla = 20260926;
const rnd = () => (semilla = (semilla * 1103515245 + 12345) % 2147483648) / 2147483648;
const elegir = a => a[Math.floor(rnd() * a.length)];
const rutFicticio = () => { const b = String(1000000 + Math.floor(rnd() * 98000000)); return b + F.dvOf(b) };
const NOMBRES = ["Comercial Ñandú Limitada", "SERVICIOS ÁGILES SPA", "José Pérez González", "Constructora 3 Hermanos", "Editorial El Árbol", "Transportes Río Petorca E.I.R.L."];

function dataset() {
  const maestro = {}, docs = [], ruts = [];
  for (let i = 0; i < 25; i++) {
    let rut = rutFicticio();
    if (i === 3) rut = rut.slice(0, -1) + (rut.slice(-1) === "1" ? "2" : "1"); // DV inválido
    const banco = i % 7 === 0 ? "012" : elegir(C.BANCOS)[0];
    const p = { rut, nombre: F.cleanName(elegir(NOMBRES) + (i % 5 === 0 ? "" : " " + "ABCDEFGHIJ"[i % 10])), email: i % 4 === 0 ? "" : "prov" + i + "@ejemplo.cl", banco, forma: i === 5 ? "02" : "01", cuenta: i % 7 === 0 ? rut.slice(0, -1) : String(Math.floor(rnd() * 1e12)), sector: i === 8 ? "99" : elegir(C.SECTORES)[0] };
    if (i === 10) p.cuenta = rut.replace("K", "0");
    maestro[rut] = p; ruts.push(rut);
  }
  const fuentes = ["GENERAL", "SEP", "PIE", "FAEP"];
  for (let i = 0; i < 120; i++) {
    const rut = i === 7 ? "111111111" : elegir(ruts);
    docs.push({ id: "d" + i, rut, fecha: i === 9 ? "" : F.two(1 + Math.floor(rnd() * 28)) + F.two(1 + Math.floor(rnd() * 12)) + "2026", monto: i === 11 ? 0 : 1000 + Math.floor(rnd() * 5e6), ndoc: String(100 + (i % 90)), tipo: i % 17 === 0 ? "61" : elegir(["33", "34", "30", "39"]), fuente: elegir(fuentes), sel: i % 9 !== 0, dc: i % 3 ? "DC " + i : undefined });
  }
  const nominas = [{ num: 1, estado: "cargada", fechaCarga: "2026-09-01", fuente: "SEP", pagos: [{ rut: docs[1].rut, estado: "pagado", docs: [{ ndoc: docs[1].ndoc, tipo: docs[1].tipo }] }, { rut: docs[2].rut, estado: "pendiente", docs: [{ ndoc: docs[2].ndoc, tipo: docs[2].tipo }] }] }];
  return { maestro, docs, nominas, fuentes };
}

// ---------- nómina y .txt ----------
ok(".txt idéntico byte a byte, mismas validaciones y totales", () => {
  const cob = { lineas: 0, errs: 0, warns: 0, agrupados: 0 };
  for (let vuelta = 0; vuelta < 8; vuelta++) {
    const { maestro, docs, nominas, fuentes } = dataset();
    const group = vuelta % 2 === 0, email = vuelta % 3 ? "finanzas@sleppetorca.gob.cl" : "";
    setRef("maestro", maestro); setRef("docs", docs); setRef("nominas", nominas);
    ref(`config.group=${group};config.email=${JSON.stringify(email)};config.fuentes=${JSON.stringify(fuentes)}`);
    assert.deepEqual(F.activeFuentes(docs, fuentes), JSON.parse(JSON.stringify(ref("activeFuentes()"))));
    for (const f of fuentes) {
      const a = ref(`build(${JSON.stringify(f)})`);
      const b = F.build(f, { docs, maestro, nominas, group, email });
      const txtA = ref(`toTxt(build(${JSON.stringify(f)}).lines)`), txtB = F.toTxt(b.lines);
      assert.equal(Buffer.from(txtB, "utf8").compare(Buffer.from(txtA, "utf8")), 0, `txt distinto en ${f}`);
      assert.ok(txtB.endsWith("\r\n"));
      assert.deepEqual(b.lines.map(l => [l.tipo, l.f]), JSON.parse(JSON.stringify(a.lines.map(l => [l.type, l.f]))));
      assert.deepEqual(JSON.parse(JSON.stringify(b.issues)), JSON.parse(JSON.stringify(a.issues)), `avisos distintos en ${f}`);
      for (const k of ["total", "nBen", "nDocs", "errs", "warns"]) assert.equal(b[k], a[k], k);
      assert.deepEqual(b.ids, JSON.parse(JSON.stringify(a.ids)));
      cob.lineas += b.lines.length; cob.errs += b.errs; cob.warns += b.warns; cob.agrupados += b.groups.filter(g => g.docs.length > 1).length;
    }
  }
  // Los datos de prueba deben ejercitar errores, avisos y agrupación.
  for (const k in cob) assert.ok(cob[k] > 0, "sin cobertura de " + k);
});

ok("validaciones de proveedor y documento", () => {
  const casos = [{ rut: "76.123.456-0", nombre: "Ñuñoa Árboles Ltda.", email: "", banco: "12", forma: "2", cuenta: "12-34.56K", sector: "64" },
    { rut: "", nombre: "", email: "x", banco: "999", forma: "03", cuenta: "", sector: "" },
    { rut: "123456785", nombre: "A".repeat(70), email: "a".repeat(41) + "@x.cl", banco: "001", forma: "02", cuenta: "1".repeat(18), sector: "64" }];
  for (const p of casos) for (const em of ["", "finanzas@sleppetorca.gob.cl"]) {
    ref(`config.email=${JSON.stringify(em)}`);
    ctx.__p = p; assert.deepEqual(F.checkProv(p, em), JSON.parse(JSON.stringify(ref("checkProv(__p)"))));
  }
  for (const d of [{ rut: "1-9", fecha: "", monto: NaN, ndoc: "12a", tipo: "7" }, { rut: "11111111-1", fecha: "01012026", monto: 12345678901, ndoc: "12345678901", tipo: "33" }]) {
    ctx.__d = d; assert.deepEqual(JSON.parse(JSON.stringify(F.checkDoc(d))), JSON.parse(JSON.stringify(ref("checkDoc(__d)"))));
  }
  for (const v of ["11/09/2026", "20260911", "11092026", "2026-09-11", "1/2/26", 46000, "31022026", "", "hola"]) { ctx.__x = v; assert.equal(F.parseFecha(v), ref("parseFecha(__x)"), String(v)) }
  for (const v of ["$1.234.567", "1234,50", 12.6, "-5", "abc", "", "1.000,00"]) { ctx.__x = v; assert.deepEqual(F.parseMonto(v), ref("parseMonto(__x)"), String(v)) }
  for (const v of [" 00012-3 ", 1.2345678901234e11, "cta ab12"]) { ctx.__x = v; assert.equal(F.normCuenta(v), ref("normCuenta(__x)")) }
});

// ---------- ingestión ----------
const sinDc = r => ({ provs: r.provs, newDocs: r.newDocs.map(({ dc, ...d }) => d) });
ok("ingestión igual a la referencia (pegar 5, 6, 7, 11, 12 y 13 columnas, encabezados)", () => {
  const txts = [
    "111111111\t11/09/2026\t630000\t405\t34",
    "111111111\t11/09/2026\t630000\t405\t34\tSEP\n123456785;20260912;1.000;406;33;PIE",
    "RUT\tNombre\tEmail\tBanco\tForma\tCuenta\tSector\n111111111\tUNO LTDA\t\t12\t1\t11111111\t64",
    "111111111\tUNO LTDA\t\t012\t01\t11111111\t64\t01/09/2026\t1000\t55\t33\n123456785\tDOS SPA\ta@b.cl\t001\t01\t998877\t64\t02/09/2026\t2000\t56\t34\tFAEP",
    "Fuente\tRUT proveedor\tFecha\tMonto\tN° doc\tTipo\n SEP\t11.111.111-1\t01/09/2026\t$5.000\t77\t33",
  ];
  for (const t of txts) {
    const a = ref(`ingest(parsePaste(${JSON.stringify(t)}),"")`), b = I.ingest(I.parsePaste(t), "");
    assert.deepEqual(sinDc(b), JSON.parse(JSON.stringify(a)), t);
  }
  // Columna DC: 7ª en el formato corto, 13ª en el completo, o por encabezado.
  assert.equal(I.ingest(I.parsePaste("111111111\t11/09/2026\t630000\t405\t34\tSEP\tDC 54"), "").newDocs[0].dc, "DC 54");
  assert.equal(I.ingest(I.parsePaste("111111111\tUNO\t\t012\t01\t1\t64\t01/09/2026\t1000\t55\t33\tSEP\tDC 9"), "").newDocs[0].dc, "DC 9");
  const h = I.ingest(I.parsePaste("RUT\tFECHA DOC\tMONTO\tN° DOC\tTIPO DOC\tFUENTE\tDC\n111111111\t11/09/2026\t630000\t405\t34\tSEP\tDC 54"), "");
  assert.equal(h.newDocs[0].dc, "DC 54"); assert.equal(h.newDocs[0].ndoc, "405"); assert.equal(h.newDocs[0].fuente, "SEP");
});

ok("planilla de pago anterior del banco reconstruye proveedores y documentos", () => {
  const { maestro, docs, nominas } = dataset();
  const r = F.build("SEP", { docs: docs.map(d => ({ ...d, sel: true, fecha: d.fecha || "01012026", monto: d.monto || 5 })), maestro: Object.fromEntries(Object.entries(maestro).filter(([k]) => F.rutOk(k))), nominas: [], group: true, email: "finanzas@sleppetorca.gob.cl" });
  const txt = F.toTxt(r.lines);
  const rows = I.parseDelimitado(txt);
  assert.ok(I.isBankSheet(rows));
  const ing = I.ingest(rows, "SEP");
  assert.deepEqual(sinDc(ing), JSON.parse(JSON.stringify(ref(`ingest(parsePaste(${JSON.stringify(txt)}),"SEP")`))));
  const prep = I.prepararIngesta(ing, { maestro: {}, fuentes: ["GENERAL", "SEP"], defFuente: "GENERAL" });
  assert.equal(prep.docs.length, r.lines.filter(l => l.tipo === 2).length);
  // Volver a armar la nómina con lo importado da el mismo archivo.
  const m2 = Object.fromEntries(prep.provs.map(c => [c.despues.rut, c.despues]));
  const r2 = F.build("SEP", { docs: prep.docs.map((d, i) => ({ ...d, id: "x" + i })), maestro: m2, nominas: [], group: true, email: "finanzas@sleppetorca.gob.cl" });
  assert.equal(F.toTxt(r2.lines), txt);
});

ok("prepararIngesta equivale a applyIngest de la referencia", () => {
  const t = "111111111\tUNO LTDA\t\t012\t\t11111111\t64\t01/09/2026\t1000\t55\t33\tsep\n111111111\tUNO LTDA\tuno@x.cl\t\t\t\t\t02/09/2026\tabc\t56\t33\tMANTENCION";
  const prev = { "111111111": { rut: "111111111", nombre: "VIEJO", email: "v@x.cl", banco: "001", forma: "01", cuenta: "5", sector: "64" } };
  setRef("maestro", prev); setRef("docs", []); ref(`config.fuentes=["GENERAL","SEP"];config.defFuente="GENERAL";renderAll=()=>{};toast=()=>{}`);
  ref(`applyIngest(ingest(parsePaste(${JSON.stringify(t)}),""))`);
  const p = I.prepararIngesta(I.ingest(I.parsePaste(t), ""), { maestro: prev, fuentes: ["GENERAL", "SEP"], defFuente: "GENERAL" });
  assert.deepEqual(p.provs[0].despues, JSON.parse(JSON.stringify(ref("maestro")))["111111111"]);
  assert.deepEqual(p.provs[0].antes, prev["111111111"]);
  const refDocs = JSON.parse(JSON.stringify(ref("docs")));
  // Diferencia buscada: el documento con monto inválido no se guarda (Firestore exige entero > 0).
  assert.equal(refDocs.length, 2); assert.equal(p.docs.length, 1); assert.equal(p.rechazados.length, 1);
  const { id, ...d0 } = refDocs[0]; assert.deepEqual(p.docs[0], d0);
});

ok("CSV del maestro exportado en el paso 1 se lee sin perder ceros", () => {
  const csv = "﻿RUT;NOMBRE;EMAIL;BANCO;FORMA DE PAGO;N CUENTA;SECTOR\r\n111111111;\"UNO; Y DOS\";;012;01;00012345678901234;64\r\n";
  const r = I.ingest(I.parseDelimitado(csv), "");
  assert.equal(r.provs.length, 1); assert.equal(r.provs[0].cuenta, "00012345678901234"); assert.equal(r.provs[0].nombre, "UNO; Y DOS");
});

// ---------- bitácora ----------
ok("estado de nóminas y día hábil siguiente (con feriados)", () => {
  const n = { estado: "cargada", fechaCarga: "2026-09-17", pagos: [{ estado: "pendiente" }] };
  const due = F.resultDue("2026-09-17", ["2026-09-18"]);
  assert.equal(F.todayISO(due), "2026-09-21"); assert.equal(due.getHours(), 14);
  assert.equal(F.todayISO(F.resultDue("2026-09-17")), F.todayISO(new Date(ref(`resultDue("2026-09-17")`))));
  for (const pagos of [[{ estado: "pendiente" }], [{ estado: "rechazado", reint: "" }, { estado: "pagado" }], [{ estado: "rechazado", reint: "2026-01-01" }], [{ estado: "pagado" }]])
    for (const estado of ["generada", "cargada", "anulada"]) {
      const m = { ...n, estado, pagos }; ctx.__n = m;
      assert.deepEqual(F.nomStatus(m), JSON.parse(JSON.stringify(ref("nomStatus(__n)"))));
    }
});

ok("resultado desde las 14:00 del día de pago", () => {
  const fer = ["2026-10-12"];
  const f = n => { const t = F.resultadoDesde(n, fer); return F.todayISO(t) + " " + t.getHours() };
  assert.equal(f({ fechaCarga: "2026-09-26", fechaPago: "2026-09-29" }), "2026-09-29 14"); // carga sáb, pago mar → mar 14:00
  assert.equal(f({ fechaCarga: "2026-09-25", fechaPago: "2026-09-26" }), "2026-09-28 14"); // pago sáb → lun
  assert.equal(f({ fechaCarga: "2026-10-09", fechaPago: "2026-10-12" }), "2026-10-13 14"); // pago feriado → hábil siguiente
  assert.equal(f({ fechaCarga: "2026-09-25" }), "2026-09-28 14");                          // sin fecha de pago: regla anterior
  assert.equal(F.esHabil("2026-09-26"), false); assert.equal(F.esHabil("2026-09-29"), true); assert.equal(F.esHabil("2026-10-12", fer), false);
  assert.equal(F.nombreDe("maria.perez@sleppetorca.gob.cl"), "Maria Perez");
});

ok("nombre de archivo", () => {
  const d = new Date(2026, 8, 26);
  assert.equal(F.fileName(F.expandPrefijo("AAAAMMDD_PAGO_PROVEEDORES", d), "SEP"), "20260926_PAGO_PROVEEDORES_SEP");
  assert.equal(F.fileName("X_.txt", "MANTENCION ESCUELAS"), "X_MANTENCION_ESCUELAS");
  // La fuente no se repite aunque el prefijo ya la traiga (ni otra fuente conocida).
  const fs = ["GENERAL", "SEP", "PIE", "FAEP", "MANTENCION ESCUELAS"];
  assert.equal(F.fileName("20260926_PAGO_PROVEEDORES_SEP", "SEP", d, fs), "20260926_PAGO_PROVEEDORES_SEP");
  assert.equal(F.fileName("20260926_PAGO_PROVEEDORES_sep_", "SEP", d, fs), "20260926_PAGO_PROVEEDORES_SEP");
  assert.equal(F.fileName("20260926_PAGO_PROVEEDORES_PIE", "SEP", d, fs), "20260926_PAGO_PROVEEDORES_SEP");
  assert.equal(F.fileName("X_MANTENCION_ESCUELAS", "MANTENCION ESCUELAS", d, fs), "X_MANTENCION_ESCUELAS");
  assert.equal(F.fileName("SEP", "SEP", d, fs), "SEP_SEP"); // un prefijo que es solo la fuente se respeta
  assert.equal(F.nombreNomina({ archivo: "20260926_PAGO_PROVEEDORES_SEP_SEP", fuente: "SEP" }), "20260926_PAGO_PROVEEDORES_SEP");
  assert.equal(F.nombreNomina({ archivo: "20260926_PAGO_PROVEEDORES_SEP", fuente: "SEP" }), "20260926_PAGO_PROVEEDORES_SEP");
});

// ---------- remuneraciones y abonos (7 columnas) ----------
ok("abonos: validación de la planilla de 7 columnas", () => {
  const base = { rut: "11.111.111-1", nombre: "Víctor Muñoz Pérez", email: "", banco: "12", forma: "29", cuenta: "", monto: 151515 };
  let c = F.checkAbono(base, "finanzas@sleppetorca.gob.cl");
  assert.deepEqual(c.e, []); assert.equal(c.out.nombre, "VICTOR MUNOZ PEREZ"); assert.equal(c.out.cuenta, ""); // pago cash: cuenta en blanco assert.equal(c.out.banco, "012");
  assert.equal(c.out.email, "finanzas@sleppetorca.gob.cl");
  c = F.checkAbono({ ...base, forma: "30", cuenta: "" }); assert.equal(c.out.cuenta, "11111111");
  c = F.checkAbono({ ...base, forma: "30", cuenta: "123" }); assert.match(c.w.join(), /CuentaRUT/);
  c = F.checkAbono({ ...base, forma: "29", banco: "001" }); assert.match(c.e.join(), /solo sirve con BancoEstado/);
  c = F.checkAbono({ ...base, forma: "01", banco: "001", cuenta: "" }); assert.match(c.e.join(), /falta número de cuenta/);
  c = F.checkAbono({ ...base, forma: "05" }); assert.match(c.e.join(), /forma de pago 05 no válida/);
  c = F.checkAbono({ ...base, monto: 0 }); assert.match(c.e.join(), /monto/);
  c = F.checkAbono({ ...base, rut: "11111111-2" }); assert.match(c.e.join(), /dígito verificador/);
});

ok("abonos: nómina, .txt de 7 columnas y avisos", () => {
  const ab = [
    { id: "a", rut: "111111111", nombre: "UNO", email: "", banco: "012", forma: "29", cuenta: "0", monto: 1000, fuente: "SEP", sel: true, concepto: "FONDOS FIJOS" },
    { id: "b", rut: "123456785", nombre: "DOS", email: "d@x.cl", banco: "001", forma: "01", cuenta: "555", monto: 2000, fuente: "SEP", sel: true, concepto: "VIATICOS" },
    { id: "c", rut: "111111111", nombre: "UNO", email: "", banco: "012", forma: "29", cuenta: "0", monto: 1000, fuente: "SEP", sel: true, concepto: "FONDOS FIJOS" },
    { id: "d", rut: "123456785", nombre: "DOS", email: "", banco: "001", forma: "01", cuenta: "555", monto: 9, fuente: "PIE", sel: true },
    { id: "e", rut: "123456785", nombre: "DOS", email: "", banco: "001", forma: "01", cuenta: "555", monto: 9, fuente: "SEP", sel: false },
  ];
  const nominas = [{ num: 4, tipo: "abonos", estado: "cargada", pagos: [{ rut: "123456785", banco: "001", forma: "01", cuenta: "999", monto: 2000, estado: "pendiente" }] }];
  const r = F.buildAbonos("SEP", { abonos: ab, nominas, group: false, email: "fin@x.cl" });
  assert.equal(r.nBen, 3); assert.equal(r.total, 4000); assert.equal(r.errs, 0);
  assert.equal(F.toTxt(r.lines), "111111111\tUNO\tfin@x.cl\t012\t29\t\t1000\r\n123456785\tDOS\td@x.cl\t001\t01\t555\t2000\r\n111111111\tUNO\tfin@x.cl\t012\t29\t\t1000\r\n");
  assert.equal(F.checkAbono({ rut: "111111111", nombre: "UNO", banco: "012", forma: "29", cuenta: "123", monto: 5 }).out.cuenta, "");
  const msgs = r.issues.map(i => i.msg).join(" | ");
  assert.match(msgs, /más de una vez/); assert.match(msgs, /nómina N° 4, aún sin resultado/); assert.match(msgs, /datos bancarios cambiaron/);
  const g = F.buildAbonos("SEP", { abonos: ab, nominas: [], group: true });
  assert.equal(g.nBen, 2); assert.equal(g.groups[0].docs.length, 2); assert.equal(g.lines[0].f[6], "2000");
  // Las nóminas de abonos no cuentan como documentos pagados de proveedores.
  assert.deepEqual(F.activeIndex(nominas), {});
  assert.equal(F.conceptoDeNombre("20260917 - REPOSICION FONDOS FIJOS EE.xlsx"), "FONDOS FIJOS");
  assert.equal(F.conceptoDeNombre("honorarios_sep.xlsx"), "HONORARIOS");
});

ok("abonos: importar la hoja DETALLE del banco y filas pegadas", () => {
  const detalle = [["", "", "Pago", "", "", "", "Versión 1.1"], ["", "", "(7 Columnas)"], ["RUT", "NOMBRES Y APELLIDOS O RAZÓN SOCIAL", "EMAIL", "BANCO", "FORMA DE PAGO", "Nº DE CUENTA", "MONTO DEL PAGO"],
    [111111111, "José Ñuñez", "FINANZAS@SLEPPETORCA.GOB.CL", "012", "29", "", 151515], ["12345678-5", "ANA", "", 1, 1, 11100066195, "$1.500"], ["", "", "", "", "", "", ""]];
  const f = I.ingestAbonos(detalle);
  assert.equal(f.length, 2);
  const p = I.prepararAbonos(f, { fuentes: ["GENERAL"], defFuente: "GENERAL", concepto: "FONDOS FIJOS" });
  assert.equal(p.abonos.length, 2); assert.equal(p.abonos[0].nombre, "JOSE NUNEZ"); assert.equal(p.abonos[1].banco, "001"); assert.equal(p.abonos[1].forma, "01");
  assert.equal(p.abonos[1].cuenta, "11100066195"); assert.equal(p.abonos[1].monto, 1500); assert.equal(p.corregidos, 1);
  const pegado = I.ingestAbonos(I.parsePaste("111111111\tUNO\t\t012\t30\t11111111\t5000\tSEP\tFondo fijo escuela"));
  const q = I.prepararAbonos(pegado, { fuentes: ["GENERAL"], defFuente: "GENERAL", concepto: "" });
  assert.equal(q.abonos[0].fuente, "SEP"); assert.equal(q.abonos[0].glosa, "Fondo fijo escuela"); assert.deepEqual(q.nuevasFuentes, ["SEP"]); assert.equal(q.abonos[0].concepto, "REMUNERACIONES");
  const malo = I.prepararAbonos(I.ingestAbonos(I.parsePaste("111111111\tUNO\t\t012\t30\t1\tabc")), { fuentes: [], defFuente: "GENERAL" });
  assert.equal(malo.abonos.length, 0); assert.equal(malo.rechazados.length, 1);
});

// Excel de 7 columnas: se arma desde la plantilla del banco y al reimportarlo da el mismo .txt.
{
  globalThis.XLSX = require(path.join(raiz, "vendor/xlsx-0.18.5.full.min.js"));
  globalThis.JSZip = require(path.join(raiz, "vendor/jszip-3.10.1.min.js"));
  globalThis.fetch = async p => ({ ok: true, arrayBuffer: async () => { const b = readFileSync(path.join(raiz, p)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length) } });
  const E = await import(path.join(raiz, "js/excel.js"));
  const ab = [["111111111", "UNO", "", "012", "29", "0", 1000], ["123456785", "DOS DOS", "d@x.cl", "001", "01", "00012345678901234", 25000], ["22222222" + F.dvOf("22222222"), "TRES", "", "012", "30", "22222222", 7]]
    .map(([rut, nombre, email, banco, forma, cuenta, monto], i) => ({ id: "x" + i, rut, nombre, email, banco, forma, cuenta, monto, fuente: "SEP", sel: true }));
  const r = F.buildAbonos("SEP", { abonos: ab, nominas: [] });
  const bytes = await E.abonosWorkbook(r.lines);
  const wb = XLSX.read(bytes, { type: "array" });
  ok("abonos: Excel de 7 columnas desde la plantilla del banco", () => {
    assert.deepEqual(wb.SheetNames, ["DETALLE", "Bancos", "Forma de Pago", "Instructivo", "Ejemplo", "pasos para txt"]);
    const filas = I.ingestAbonos(XLSX.utils.sheet_to_json(wb.Sheets.DETALLE, { header: 1, raw: true, defval: "" }));
    const p = I.prepararAbonos(filas, { fuentes: ["SEP"], defFuente: "SEP" });
    const r2 = F.buildAbonos("SEP", { abonos: p.abonos.map((a, i) => ({ ...a, id: "y" + i })), nominas: [] });
    assert.equal(F.toTxt(r2.lines), F.toTxt(r.lines));
    assert.equal(wb.Sheets.DETALLE.F5.v, "00012345678901234"); // la cuenta va como texto, sin perder ceros
    assert.equal(wb.Sheets.DETALLE.G4.t, "n");                  // el monto va como número
  });
}

// Reporte de pagos: filtra por fecha de pago (o de carga en las antiguas), suma por estado y arma el Excel.
{
  const E = await import(path.join(raiz, "js/excel.js"));
  const pago = (rut, monto, estado, docs, extra = {}) => ({ rut, nombre: "BEN " + rut, banco: "012", cuenta: "1", monto, estado, motivo: estado === "rechazado" ? "cuenta cerrada" : "", reint: "", docs, ...extra });
  const nominas = [
    { num: 1, estado: "cargada", fuente: "SEP", fechaCarga: "2026-09-25", fechaPago: "2026-09-28", operacion: "900", total: 1500, pagos: [pago("111111111", 1000, "pagado", [{ ndoc: "10", tipo: "33", fecha: "01092026", monto: 1200, dc: "DC 5" }, { ndoc: "3", tipo: "61", fecha: "02092026", monto: 200 }]), pago("123456785", 500, "rechazado", [{ ndoc: "11", tipo: "33", fecha: "01092026", monto: 500 }])] },
    { num: 2, estado: "cargada", fuente: "GENERAL", tipo: "abonos", concepto: "VIATICOS", fechaCarga: "2026-09-29", fechaPago: "2026-09-30", operacion: "901", total: 300, pagos: [pago("111111111", 300, "pagado", [{ monto: 300, concepto: "VIATICOS", glosa: "Comisión" }])] },
    { num: 3, estado: "cargada", fuente: "SEP", fechaCarga: "2026-09-30", fechaPago: "", total: 70, pagos: [pago("111111111", 70, "pendiente", [{ ndoc: "12", tipo: "33", fecha: "01092026", monto: 70 }])] },
    { num: 4, estado: "generada", fuente: "SEP", fechaCarga: "", fechaPago: "", total: 5, pagos: [pago("111111111", 5, "pendiente", [])] },
    { num: 5, estado: "cargada", fuente: "SEP", fechaCarga: "2026-08-28", fechaPago: "2026-08-31", total: 9, pagos: [pago("111111111", 9, "pagado", [{ ndoc: "1", tipo: "33", fecha: "01082026", monto: 9 }])] },
  ];
  const r = F.reportePagos(nominas, { desde: "2026-09-01", hasta: "2026-09-30" });
  ok("reporte de pagos: período por fecha de pago, sin generadas, montos por estado", () => {
    assert.deepEqual(r.nominas.map(n => n.num), [1, 2, 3]);  // la 3 sin fecha de pago usa la de carga; la 4 no se cargó; la 5 es de agosto
    assert.deepEqual(r.tot, { nominas: 3, pagado: 1300, nPagado: 2, rechazado: 500, nRechazado: 1, pendiente: 70, nPendiente: 1, porCobrar: 0, nPorCobrar: 0 });
    assert.deepEqual(r.resumen.map(g => [g.tipo, g.fuente, g.pagado]), [["Proveedores", "SEP", 1000], ["Remuneraciones", "GENERAL", 300]]);
    assert.deepEqual(F.reportePagos(nominas, { desde: "2026-09-01", hasta: "2026-09-30", tipo: "abonos" }).nominas.map(n => n.num), [2]);
    assert.deepEqual(F.reportePagos(nominas, { fuente: "SEP" }).nominas.map(n => n.num), [5, 1, 3]);
  });
  const wb = XLSX.read(E.libroReporte(F.reporteHojas(r, { desde: "2026-09-01", hasta: "2026-09-30", generado: "30/09/2026 15:00", por: "Wilson Rojas" })), { type: "array", cellNF: true });
  ok("reporte de pagos: Excel con resumen, detalle pagado por documento y rechazos", () => {
    assert.deepEqual(wb.SheetNames, ["Resumen", "Pagado", "Rechazados"]);
    const hoja = n => XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: "" });
    const pg = hoja("Pagado");
    assert.equal(pg.length, 1 + 3 + 1); // encabezado, 2 documentos de la nómina 1, 1 abono, total
    assert.deepEqual(pg[1].slice(0, 7), ["28/09/2026", 1, "900", "Proveedores", "SEP", "11.111.111-1", "BEN 111111111"]);
    assert.deepEqual([pg[1][13], pg[1][14], pg[2][13], pg[2][14]], [1200, 1000, -200, ""]); // la NC resta y el pago va una vez
    assert.deepEqual([pg[3][9], pg[3][12], pg[3][14]], ["VIATICOS", "Comisión", 300]);
    assert.equal(pg[4][14], 1300);
    assert.equal(wb.Sheets.Pagado.O2.z, '"$"#,##0;-"$"#,##0');
    const rc = hoja("Rechazados");
    assert.deepEqual([rc[1][1], rc[1][9], rc[1][10], rc[1][11]], [1, 500, "cuenta cerrada", "No"]);
    const rs = hoja("Resumen");
    assert.equal(rs[1][1], "01/09/2026 al 30/09/2026");
    assert.deepEqual(rs.find(f => f[0] === "TOTAL").slice(2, 9), [3, 2, 1300, 1, 500, 1, 70]);
  });
}

// Pago cash / vale vista de remuneraciones: pendiente de cobro, cobrado o no cobrado (devuelto).
{
  const E = await import(path.join(raiz, "js/excel.js"));
  const caja = (rut, monto, cobro = "", extra = {}) => ({ rut, nombre: "DIRECTOR " + rut, banco: "012", forma: "20", cuenta: "", monto, estado: "pagado", motivo: "", reint: "", cobro, cobroFecha: cobro ? "2026-10-02" : "", docs: [{ monto, concepto: "FONDOS FIJOS", glosa: "" }], ...extra });
  const nom = pagos => ({ num: 9, tipo: "abonos", concepto: "FONDOS FIJOS", estado: "cargada", fuente: "GENERAL", fechaCarga: "2026-09-29", fechaPago: "2026-09-30", operacion: "700001", total: pagos.reduce((a, p) => a + p.monto, 0), pagos });
  ok("pago cash: la nómina queda por cobrar en banco hasta que se cobra o se devuelve", () => {
    const transf = { rut: "111111111", nombre: "X", banco: "012", forma: "01", cuenta: "1", monto: 5, estado: "pagado", docs: [] };
    assert.equal(F.nomStatus(nom([caja("900000014", 150000), caja("90000020", 120000, "cobrado")])).t, "Pagada, 1 por cobrar en banco");
    assert.equal(F.nomStatus(nom([caja("900000014", 150000), caja("90000020", 120000, "cobrado")])).k, "cobro");
    assert.equal(F.nomStatus(nom([caja("900000014", 150000, "cobrado"), transf])).t, "Procesada, todo pagado");
    assert.equal(F.nomStatus(nom([caja("900000014", 150000, "devuelto"), caja("90000020", 120000, "cobrado")])).t, "Procesada, 1 por reintegrar");
    assert.equal(F.nomStatus(nom([caja("900000014", 150000, "devuelto", { reint: "2026-10-03" })])).t, "Procesada, 1 no cobrado");
    // Una transferencia (forma 01) o un pago de proveedores no tiene cobro en banco.
    assert.equal(F.nomStatus(nom([transf])).k, "ok");
    assert.equal(F.nomStatus({ ...nom([caja("900000014", 1)]), tipo: undefined }).k, "ok");
  });
  const r = F.reportePagos([nom([caja("900000014", 150000), caja("90000020", 120000, "cobrado"), caja("900000030", 100000, "devuelto")])], {});
  ok("pago cash en el reporte: por cobrar aparte, el no cobrado va con los rechazados", () => {
    assert.deepEqual([r.tot.pagado, r.tot.nPagado, r.tot.porCobrar, r.tot.rechazado, r.tot.nRechazado], [270000, 2, 150000, 100000, 1]);
    const T = F.reporteTablas(r);
    assert.deepEqual(T.pagado.body.map(f => f[15]), ["Pendiente de cobro", "Cobrado 02/10/2026"]);
    assert.equal(T.pagado.foot[15], "Por cobrar $150.000");
    assert.equal(T.rechazados.body[0][10], "No cobrado en banco, devuelto a la cuenta el 02/10/2026");
    assert.deepEqual(T.resumen.foot[9], { $: 150000 });
    const wb = XLSX.read(E.libroReporte(F.reporteHojas(r, {})), { type: "array" });
    assert.equal(XLSX.utils.sheet_to_json(wb.Sheets.Pagado, { header: 1, defval: "" })[1][15], "Pendiente de cobro");
  });
}

// Transferencias electrónicas: tercer tipo de la bitácora, nacen pagadas.
{
  const tef = (origen, docs, extra = {}) => ({ num: 12, tipo: "transferencia", origen, estado: "cargada", fuente: "JUNJI", fechaCarga: "2026-09-30", fechaPago: "2026-09-30", operacion: "8800001", concepto: "AGUA JUNJI", total: 250000,
    pagos: [{ rut: "965432108", nombre: "SANITARIA DE PRUEBA", banco: "012", cuenta: "99988877766", monto: 250000, estado: "pagado", motivo: "", reint: "", docs }], ...extra });
  const conDoc = tef("documentos", [{ docId: "d1", ndoc: "5501", tipo: "33", fecha: "01092026", monto: 250000, dc: "" }]);
  const suelto = tef("suelto", [{ monto: 250000, concepto: "AGUA JUNJI", glosa: "MEMO 12" }]);
  const abono = { ...tef("abonos", [{ abonoId: "a1", monto: 1000000, concepto: "REMUNERACIONES", glosa: "" }]), num: 13, fuente: "GENERAL", operacion: "8800002", total: 1000000 };
  abono.pagos[0] = { ...abono.pagos[0], rut: "900000049", nombre: "PERSONA", monto: 1000000 };
  ok("transferencias: tipo, estado 'Transferencia pagada' e índice de documentos ya pagados", () => {
    assert.deepEqual([conDoc, suelto, abono, { tipo: "abonos" }, {}].map(F.tipoDe), ["transferencia", "transferencia", "transferencia", "abonos", "proveedores"]);
    assert.deepEqual([conDoc, suelto, abono].map(F.conDocumentos), [true, false, false]);
    assert.deepEqual([conDoc, suelto, abono].map(F.conAbonos), [false, false, true]);
    assert.equal(F.nomStatus(conDoc).t, "Transferencia pagada");
    assert.equal(F.nomStatus({ ...suelto, pagos: [{ ...suelto.pagos[0], estado: "rechazado" }] }).k, "reintegrar");
    // La factura pagada por transferencia avisa si se vuelve a cargar; la transferencia suelta no entra al índice.
    assert.deepEqual(F.activeIndex([conDoc, suelto]), { "965432108|33|5501": "12 (pagado)" });
    assert.deepEqual(F.activeIndex([{ ...conDoc, estado: "anulada" }]), {});
  });
  ok("transferencias en el reporte: filtro por tipo y detalle por documento o concepto", () => {
    const r = F.reportePagos([conDoc, suelto, abono, { num: 1, estado: "cargada", fuente: "SEP", fechaPago: "2026-09-30", total: 5, pagos: [{ rut: "111111111", nombre: "X", banco: "012", cuenta: "1", monto: 5, estado: "pagado", docs: [{ ndoc: "1", tipo: "33", fecha: "01092026", monto: 5 }] }] }], { tipo: "transferencia" });
    assert.deepEqual(r.nominas.map(n => n.num), [12, 12, 13]);
    assert.deepEqual(r.resumen.map(g => [g.tipo, g.fuente, g.nominas, g.pagado]), [["Transferencias", "GENERAL", 1, 1000000], ["Transferencias", "JUNJI", 2, 500000]]);
    const T = F.reporteTablas(r);
    assert.deepEqual(T.pagado.body.map(f => [f[2], f[3], f[9], f[12]]), [["8800001", "Transferencias", "5501", ""], ["8800001", "Transferencias", "AGUA JUNJI", "MEMO 12"], ["8800002", "Transferencias", "REMUNERACIONES", ""]]);
  });
}

// Reporte en PDF: mismo contenido que el Excel (se revisa el texto de las páginas).
{
  const { jsPDF } = require(path.join(raiz, "vendor/jspdf-4.2.1.umd.min.js"));
  const { autoTable } = await import(path.join(raiz, "vendor/jspdf-autotable-5.0.8.mjs"));
  const P = await import(path.join(raiz, "js/pdf.js"));
  const zlib = await import("node:zlib");
  const pago = (rut, monto, estado, docs) => ({ rut, nombre: "BENEFICIARIO " + rut, banco: "012", cuenta: "1", monto, estado, motivo: estado === "rechazado" ? "cuenta cerrada" : "", reint: "", docs });
  const muchos = Array.from({ length: 60 }, (_, i) => pago("111111111", 1000, "pagado", [{ ndoc: String(100 + i), tipo: "33", fecha: "01092026", monto: 1000 }]));
  const nominas = [{ num: 7, estado: "cargada", fuente: "SEP", fechaCarga: "2026-09-29", fechaPago: "2026-09-30", operacion: "4455", cargadaPor: "maria.perez@sleppetorca.gob.cl", total: 60500, pagos: [...muchos, pago("123456785", 500, "rechazado", [{ ndoc: "9", tipo: "33", fecha: "01092026", monto: 500 }])] }];
  const r = F.reportePagos(nominas, { desde: "2026-09-01", hasta: "2026-09-30" });
  const buf = Buffer.from(P.pdfReporte(r, { desde: "2026-09-01", hasta: "2026-09-30", filtros: "Tipo: Todas · Fuente: Todas", generado: "30/09/2026 15:00", por: "Wilson Rojas" }, { jsPDF, autoTable }));
  const bin = buf.toString("latin1");
  let texto = "";
  for (const m of bin.matchAll(/stream\r?\n/g)) { const ini = m.index + m[0].length, fin = bin.indexOf("endstream", ini); try { texto += zlib.inflateSync(buf.subarray(ini, fin)).toString("latin1") } catch { } }
  texto = texto.replace(/\\([()\\])/g, "$1"); // el PDF escapa los paréntesis
  ok("reporte de pagos: PDF con encabezado, totales, tablas en varias páginas y pie", () => {
    assert.equal(bin.slice(0, 5), "%PDF-");
    const paginas = (bin.match(/\/Type \/Page\b/g) || []).length;
    assert.ok(paginas >= 2, "páginas: " + paginas);
    for (const t of ["Reporte de pagos BancoEstado", "Período (fecha de pago): 01/09/2026 al 30/09/2026 · Tipo: Todas · Fuente: Todas", "Generado el 30/09/2026 15:00 por Wilson Rojas",
      "$60.000", "Resumen por tipo y fuente", "Nóminas del período", "Detalle de lo pagado", "Rechazados", "cuenta cerrada", "4455", "Maria Perez", "Página 1 de " + paginas, "TOTAL PAGADO"])
      assert.ok(texto.includes("(" + t + ")") || texto.includes(t), "falta en el PDF: " + t);
  });

  // Reporte de pago de una nómina: el respaldo de que esa nómina se pagó.
  const textoPdf = ab => { const bf = Buffer.from(ab), bn = bf.toString("latin1"); let tx = ""; for (const m of bn.matchAll(/stream\r?\n/g)) { const ini = m.index + m[0].length, fin = bn.indexOf("endstream", ini); try { tx += zlib.inflateSync(bf.subarray(ini, fin)).toString("latin1") } catch { } } return { bn, tx: tx.replace(/\\([()\\])/g, "$1") } };
  const nom = { ...nominas[0], creadaPor: "juan.soto@sleppetorca.gob.cl", obs: "visto bueno jefatura", lineas: [] };
  const meta = { estado: "Procesada, 1 por reintegrar", creada: "29/09/2026", generado: "30/09/2026 15:00", por: "Wilson Rojas",
    historial: [{ fecha: "29/09/26 10:00", accion: "generar nómina", detalle: "N° 7 SEP: 61 pagos", autor: "Juan Soto" }, { fecha: "30/09/26 15:00", accion: "resultado de pago", detalle: "rechazado: cuenta cerrada", autor: "Maria Perez" }] };
  ok("reporte de pago de una nómina: ficha, totales, pagado, rechazados e historial, en Excel y PDF", () => {
    const ficha = Object.fromEntries(F.fichaNomina(nom, meta));
    assert.equal(ficha["Nómina N°"], "7"); assert.equal(ficha["N° nómina BancoEstado"], "4455"); assert.equal(ficha["Estado"], meta.estado);
    assert.equal(ficha["Generada"], "29/09/2026 por Juan Soto"); assert.equal(ficha["Cargada en BancoEstado"], "29/09/2026 por Maria Perez");
    assert.equal(ficha["Fecha de pago"], "30/09/2026"); assert.equal(ficha["Pagos"], "61, con 61 documentos"); assert.equal(ficha["Total"], "$60.500"); assert.equal(ficha["Observación"], "visto bueno jefatura");
    const hojas = F.reporteNominaHojas(nom, meta);
    assert.deepEqual(hojas.map(h => h.nombre), ["Nómina", "Pagado", "Rechazados", "Historial"]);
    assert.deepEqual(hojas[0].filas[0], ["REPORTE DE PAGO · NÓMINA N° 7"]);
    assert.deepEqual(hojas[0].filas.find(f => f[0] === "Pagado"), ["Pagado", { $: 60000 }, 60]);
    assert.equal(hojas[1].filas.length, 1 + 60 + 1); // encabezado, 60 documentos pagados y total
    assert.equal(hojas[2].filas[1][10], "cuenta cerrada");
    assert.deepEqual(hojas[3].filas[2], ["30/09/26 15:00", "resultado de pago", "rechazado: cuenta cerrada", "Maria Perez"]);
    assert.equal(F.nombreReporteNomina(nom), "reporte_pago_nomina_7");
    const { bn, tx } = textoPdf(P.pdfNomina(nom, meta, { jsPDF, autoTable }));
    assert.equal(bn.slice(0, 5), "%PDF-");
    const paginas = (bn.match(/\/Type \/Page\b/g) || []).length;
    for (const t of ["Reporte de pago · Nómina N° 7", "BancoEstado N° 4455 · SEP · Procesada, 1 por reintegrar", "Generado el 30/09/2026 15:00 por Wilson Rojas", "Datos de la nómina",
      "Cargada en BancoEstado", "29/09/2026 por Maria Perez", "$60.000", "Detalle de lo pagado", "TOTAL PAGADO", "Rechazados", "cuenta cerrada", "Historial", "resultado de pago", "visto bueno jefatura", "Página 1 de " + paginas])
      assert.ok(tx.includes("(" + t + ")") || tx.includes(t), "falta en el PDF de la nómina: " + t);
    // Transferencia: la ficha trae los datos del comprobante.
    const tf = { num: 12, tipo: "transferencia", origen: "suelto", estado: "cargada", fuente: "JUNJI", fechaPago: "2026-09-30", horaTef: "16:47", operacion: "8800001", idTef: "5550001234", cuentaOrigen: "11100000001", cuentaNombre: "Subvencion Ejemplo", concepto: "AGUA", mensaje: "MEMO 1", preparo: "Persona Uno", autorizo: "Persona Dos", total: 5000,
      pagos: [{ rut: "111111111", nombre: "SANITARIA", banco: "012", cuenta: "1", monto: 5000, estado: "pagado", motivo: "", reint: "", docs: [{ monto: 5000, concepto: "AGUA", glosa: "MEMO 1" }] }] };
    const ft = Object.fromEntries(F.fichaNomina(tf, { estado: "Transferencia pagada", creada: "30/09/2026" }));
    assert.deepEqual([ft["Transferencia N°"], ft["Registro N°"], ft["Fecha y hora"], ft["ID TEF"], ft["Cuenta de origen"], ft["Autorizó"]], ["8800001", "12", "30/09/2026 16:47", "5550001234", "11100000001 (Subvencion Ejemplo)", "Persona Dos"]);
    assert.equal(F.nombreReporteNomina(tf), "reporte_pago_transferencia_8800001");
    assert.ok(textoPdf(P.pdfNomina(tf, { estado: "Transferencia pagada", creada: "30/09/2026", generado: "x", historial: [] }, { jsPDF, autoTable })).tx.includes("Datos de la transferencia"));
  });
}

// Detalle de Nómina de BancoEstado, vista "Ver Documento" (mismos encabezados
// que el archivo real, con RUT, nombres, N° y montos inventados).
ok("Detalle de Nómina del banco por documento: tipo en texto, monto de cada documento, sin duplicar", () => {
  const R1 = "11.111.111-1", R2 = "22.222.222-2";
  const filas = [
    ["Mis Nóminas - Ver Nómina - Ver Documento"], [], ["Fecha : Oct 5, 2026, 11:44:28 AM"], [], ["Detalle Nómina"],
    ["Convenio", "SLEP EJEMPLO PROVEEDORES(PROV-000)\t", "Nº Nómina", 900100],
    ["Nombre Nómina", "P02_EJEMPLO_FAEP", "Monto Total $", "$350.000"],
    ["Cantidad Pagos", "2", "Fecha Pago", "05/10/2026"],
    ["Concepto Pago", "Proveedores", "Estado Nómina Pagos", "Provisión Autorizada"], [],
    ["Rut", "Nombre", "Centro Negocio", "Tipo Abono", "Banco", "Monto Total $", "Estado", "Motivo", "N° Documento", "Tipo Documento", "Fecha Emisión", "Monto $"],
    // Un pago con dos documentos y una nota de crédito: "Monto Total $" se repite.
    [R1, "COMERCIAL UNO S.A  ", "", "Abono en Cuenta Corriente / Cuenta Vista", "BANCO SANTANDER-CHILE", "$ 250.000", "Aceptado en validación", "", 101, "FACTURA ELECTRONICA", "31/08/2026", "$ 200.000"],
    [R1, "COMERCIAL UNO S.A  ", "", "Abono en Cuenta Corriente / Cuenta Vista", "BANCO SANTANDER-CHILE", "$ 250.000", "Aceptado en validación", "", 102, "FACTURA NO AFECTA O EXENTA ELECTRONICA", "31/08/2026", "$ 60.000"],
    [R1, "COMERCIAL UNO S.A  ", "", "Abono en Cuenta Corriente / Cuenta Vista", "BANCO SANTANDER-CHILE", "$ 250.000", "Aceptado en validación", "", 7, "NOTA DE CREDITO ELECTRONICA", "01/09/2026", "$ 10.000"],
    [R2, "SERVICIOS DOS SPA", "", "Abono en Cuenta de Ahorro", "BANCO DEL ESTADO DE CHILE", "$ 100.000", "Aceptado en validación", "", 55, "BOLETA DE HONORARIOS ELECTRONICA", "02/09/2026", "$ 100.000"]
  ];
  const r = I.ingest(filas, "");
  assert.equal(r.nombreNomina, "P02_EJEMPLO_FAEP");
  assert.deepEqual(r.newDocs.map(d => [d.ndoc, d.monto]), [[101, "$ 200.000"], [102, "$ 60.000"], [7, "$ 10.000"], [55, "$ 100.000"]]); // el del documento, no el total del pago
  assert.equal(r.provs.length, 2);
  assert.deepEqual([r.provs[0].banco, r.provs[0].forma, r.provs[1].banco, r.provs[1].forma], ["037", "01", "012", "02"]);
  const fuentes = ["GENERAL", "FAEP"];
  // Proveedor que ya está en el maestro: el archivo no trae cuenta, así que no se toca.
  const maestro = { "111111111": { rut: "111111111", nombre: "COMERCIAL UNO SA", banco: "001", forma: "01", cuenta: "123456", sector: "64" } };
  const p = I.prepararIngesta(r, { maestro, fuentes, defFuente: "FAEP" });
  assert.deepEqual(p.docs.map(d => d.tipo), ["33", "34", "61", ""]); // la boleta de honorarios no está en la tabla del SII del panel
  assert.equal(p.sinTipo, 1);
  assert.deepEqual(p.provs.map(c => c.despues.rut), ["222222222"]);
  assert.equal(p.sinCuenta, 1);
  // Subirlo otra vez no duplica; a los pendientes sin tipo válido se les completa.
  const pend = p.docs.map((d, i) => ({ ...d, id: "d" + i, tipo: i === 0 ? "" : d.tipo }));
  const p2 = I.prepararIngesta(r, { maestro, fuentes, defFuente: "FAEP", pendientes: pend });
  assert.equal(p2.docs.length, 0);
  assert.deepEqual(p2.corregir.map(c => [c.id, c.antes, c.tipo]), [["d0", "", "33"]]);
  assert.equal(p2.repetidos, 3);
  // Los tipos del SII también se leen en texto al pegar o desde otras planillas.
  assert.deepEqual(["33", "33 Factura electrónica", 61, "Nota de débito electrónica", "Factura exenta electrónica", "Abono en Cuenta Corriente"].map(I.tipoDoc), ["33", "33", "61", "56", "34", ""]);
});

// Detalle de Nómina de Remuneraciones del banco (una fila por pago), con datos inventados.
ok("Detalle de Nómina de Remuneraciones del banco: banco y forma en texto, concepto y fuente del nombre de la nómina", () => {
  const filas = [
    ["Mis Nóminas - Remuneraciones - Ver Nómina"], [], ["Fecha : Oct 5, 2026, 2:35:22 PM"], [], ["Detalle Nómina"],
    ["Convenio", "SLEP EJEMPLO REMUNERACIONES(REM-000)\t", "Nº Nómina", 900200],
    ["Nombre Nómina", "P02_FONDO_FIJO_EE_GENERAL", "Monto Total $", "$61.000"],
    ["Cantidad Pagos", "3", "Fecha Pago", "05/10/2026"], ["Concepto Pago", "Anticipos", "Estado Nómina Pagos", "Aceptada"], [],
    ["Rut", "Nombre", "Fecha Abono", "Forma Abono", "Banco", "Código Propio", "N° Cuenta", "Estado Abono", "Motivo", "Monto Abono"],
    ["11.111.111-1", "Persona Uno Ejemplo  ", "05/10/2026", "Abono en CuentaRUT", "BANCOESTADO", "", "11111111", "Pagado", "      ", "$ 10.000"],
    ["22.222.222-2", "Persona Dos Ejemplo", "05/10/2026", "Abono en Cuenta Corriente / Cuenta Vista", "BANCO DE CREDITO E INVERSIONES", "", "123456789", "Pagado", "", "$ 20.000"],
    ["33.333.333-3", "Persona Tres Ejemplo", "05/10/2026", "Pago Cash", "BANCOESTADO", "", "", "Pendiente de Cobro", "", "$ 31.000"]
  ];
  assert.equal(I.nombreNominaBanco(filas), "P02_FONDO_FIJO_EE_GENERAL");
  assert.equal(F.conceptoDeNombre(I.nombreNominaBanco(filas)), "FONDOS FIJOS");
  const fuentes = ["GENERAL", "SEP"];
  const leidas = I.ingestAbonos(filas).map(a => ({ ...a, fuente: "GENERAL" }));
  const p = I.prepararAbonos(leidas, { fuentes, defFuente: "SEP", concepto: "FONDOS FIJOS" });
  assert.deepEqual(p.abonos.map(a => [a.banco, a.forma, a.cuenta, a.monto, a.nombre]), [["012", "30", "11111111", 10000, "PERSONA UNO EJEMPLO"], ["016", "01", "123456789", 20000, "PERSONA DOS EJEMPLO"], ["012", "29", "", 31000, "PERSONA TRES EJEMPLO"]]);
  assert.deepEqual(p.abonos.map(a => F.checkAbono(a, "finanzas@ejemplo.cl").e), [[], [], []]);
  // Ya cargados antes con banco y forma vacíos: se corrigen, y una tercera vez no se duplica.
  const mal = p.abonos.map((a, i) => ({ ...a, id: "a" + i, banco: "", forma: "", concepto: "REMUNERACIONES", fuente: "SEP" }));
  const p2 = I.prepararAbonos(leidas, { fuentes, defFuente: "SEP", concepto: "FONDOS FIJOS", pendientes: mal });
  assert.equal(p2.abonos.length, 0);
  assert.deepEqual(p2.corregir.map(c => [c.id, c.despues.banco, c.despues.forma, c.despues.concepto, c.despues.fuente]), [["a0", "012", "30", "FONDOS FIJOS", "GENERAL"], ["a1", "016", "01", "FONDOS FIJOS", "GENERAL"], ["a2", "012", "29", "FONDOS FIJOS", "GENERAL"]]);
  const p3 = I.prepararAbonos(leidas, { fuentes, defFuente: "SEP", concepto: "FONDOS FIJOS", pendientes: p2.corregir.map(c => c.despues) });
  assert.deepEqual([p3.abonos.length, p3.corregir.length, p3.repetidos], [0, 0, 3]);
  // Códigos y textos de forma de pago.
  assert.deepEqual(["30", 1, "Abono en Cuenta de Ahorro", "Chequera Electrónica", "Vale Vista", "Pago Cash", ""].map(I.formaAbono), ["30", "01", "02", "22", "", "29", ""]);
  assert.deepEqual(["12", "BANCOESTADO", "BANCO DEL ESTADO DE CHILE", "BANCO DE CREDITO E INVERSIONES"].map(I.bancoCodigo), ["012", "012", "012", "016"]);
});

ok("index.html con las versiones de los archivos al día", () => {
  const { execFileSync } = require("node:child_process");
  execFileSync(process.execPath, [path.join(raiz, "tests/versionar.mjs"), "--revisar"], { stdio: "pipe" });
});

console.log(`\n${pruebas} pruebas OK`);
