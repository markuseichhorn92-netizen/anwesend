'use strict';

/**
 * Team-Backend: Statistiken (nur echte Daten).
 *   GET (Bearer Team-Token) -> {
 *     ok, counts:{total,open,neu,done,unread},
 *     vorgangBreakdown:[{type,count}],          // aus dem Posteingang
 *     checkinDays:[{d,v}], avgUtil,             // typische Auslastung (anonyme Historie)
 *     topArticles:[{title,views,cat}], articlesPublished, articleViews
 *   }
 * Bewusst keine erfundenen Kennzahlen (MRR/Kündigungsquote) – nur Werte, die wir
 * mit den vorhandenen Datenquellen wirklich haben.
 */

const TA = require('../../lib/teamAuth');
const Inbox = require('../../lib/inbox');
const Articles = require('../../lib/articles');
const Store = require('../../lib/store');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const sess = await TA.requireTeam(req);
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
  if (req.method !== 'GET') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }

  let all = [];
  try { all = await Inbox.listAll({ limit: 400 }); } catch (e) {}
  const byType = {};
  all.forEach((v) => { byType[v.type] = (byType[v.type] || 0) + 1; });
  const vorgangBreakdown = Object.keys(byType).map((t) => ({ type: t, count: byType[t] })).sort((a, b) => b.count - a.count);
  const counts = {
    total: all.length,
    open: all.filter((v) => v.teamStatus !== 'abgeschlossen').length,
    neu: all.filter((v) => v.teamStatus === 'neu').length,
    done: all.filter((v) => v.teamStatus === 'abgeschlossen').length,
    unread: all.filter((v) => v.teamUnread).length,
  };

  let arts = [];
  try { await Articles.seedDefaults(); } catch (e) {}   // Standard-Artikel beim ersten Mal anlegen
  try { arts = await Articles.list(); } catch (e) {}
  const articlesPublished = arts.filter((a) => a.status === 'veröffentlicht').length;
  const articleViews = arts.reduce((s, a) => s + (a.views || 0), 0);
  const topArticles = arts.slice().sort((a, b) => (b.views || 0) - (a.views || 0)).slice(0, 5)
    .map((a) => ({ title: a.title, views: a.views || 0, cat: a.cat }));

  // Typische Auslastung pro Wochentag (Spitze) aus der anonymen Historie.
  let week = null;
  try { week = await Store.getTypicalWeek(); } catch (e) {}
  const order = [1, 2, 3, 4, 5, 6, 0];   // store: 0=So..6=Sa -> Mo..So
  const labels = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
  let checkinDays = labels.map((d) => ({ d, v: 0 }));
  let avgUtil = 0;
  if (Array.isArray(week)) {
    let sum = 0, n = 0;
    checkinDays = order.map((wd, i) => {
      const day = week[wd] || [];
      let peak = 0;
      day.forEach((x) => { if (x != null) { if (x > peak) peak = x; sum += x; n++; } });
      return { d: labels[i], v: Math.round(peak) };
    });
    avgUtil = n ? Math.round(sum / n) : 0;
  }

  res.statusCode = 200;
  return res.end(JSON.stringify({ ok: true, counts, vorgangBreakdown, topArticles, articlesPublished, articleViews, checkinDays, avgUtil }));
};
