'use strict';

/**
 * Prüfungen für die beiden Oberflächen-Dateien (mitglieder.html, team-backend.html).
 *
 * Warum es das gibt: der Syntax-Lint lief bisher nur über api/, lib/, scripts/, tests/
 * und server.js. Die gesamte App liegt aber als Inline-<script> in den HTML-Dateien –
 * rund 20.000 Zeilen, die nie geprüft wurden. Ein Tippfehler dort wäre grün durch
 * `npm run check` gelaufen, deployt worden und hätte die App auf jedem Gerät lahmgelegt.
 *
 * Zusätzlich der Abgleich tote Klick-Ziele: Buttons tragen `data-act="name"`, ein
 * delegierter Handler schlägt `name` in der Aktions-Map nach. Fehlt der Eintrag, tut der
 * Button nichts – ohne Fehlermeldung, ohne Testabdeckung. Genau so sind zwei kaputte
 * Buttons monatelang unbemerkt geblieben.
 *
 * Reines Bord-Node, kein externes Tooling (wie scripts/lint.js).
 */

// Inline-<script>-Blöcke (ohne src=) mit ihrer Startzeile im Dokument.
function inlineScripts(html) {
  const out = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    out.push({ code: m[1], line: html.slice(0, m.index).split('\n').length });
  }
  return out;
}

// Literale data-act-Ziele. Dynamisch zusammengebaute (data-act="'+x+'") lassen sich
// statisch nicht auflösen und bleiben bewusst außen vor – lieber nichts melden als falsch.
function declaredActions(html) {
  const set = new Set();
  const re = /data-act="([A-Za-z_$][\w$]*)"/g;
  let m;
  while ((m = re.exec(html))) set.add(m[1]);
  return set;
}

// Handler-Namen aus den Inline-Skripten: `name:function`, auch mit Leerzeichen
// oder in Anführungszeichen.
function declaredHandlers(html) {
  const set = new Set();
  const re = /(?:^|[{,\s])['"]?([A-Za-z_$][\w$]*)['"]?\s*:\s*function\b/g;
  for (const s of inlineScripts(html)) {
    let m;
    while ((m = re.exec(s.code))) set.add(m[1]);
    re.lastIndex = 0;
  }
  return set;
}

// data-act-Ziele ohne Gegenstück = Buttons, die beim Antippen nichts tun.
function deadActions(html) {
  const handlers = declaredHandlers(html);
  return [...declaredActions(html)].filter((a) => !handlers.has(a)).sort();
}

module.exports = { inlineScripts, declaredActions, declaredHandlers, deadActions };
