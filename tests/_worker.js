'use strict';
// Processo independente com SUA PRÓPRIA conexão SQLite. Espera o instante "t0" e dispara a reserva.
const db = require('../src/db');
const [,, caminho, numero, nome, t0] = process.argv;
const conn = db.abrir(caminho);
const espera = Number(t0) - Date.now();
const fim = Date.now() + Math.max(0, espera);
while (Date.now() < fim) { /* busy-wait: sincroniza o disparo dos processos */ }
const r = db.reservar(conn, Number(numero), nome, '11999998888');
console.log(JSON.stringify({ nome, ...r }));
