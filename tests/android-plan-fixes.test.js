const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const ai = read('lib/ai.js');
const member = read('mitglieder.html');
const vercel = JSON.parse(read('vercel.json'));

assert.strictEqual(
  (ai.match(/maxTokens: 4096, temperature: 0\.4, model: MODEL_PLAN, timeoutMs: 110000/g) || []).length,
  2,
  'training and nutrition plans must have enough output budget and runtime'
);
assert.ok(ai.includes('aiTimeout(opts.timeoutMs)'), 'AI calls must honor the per-request timeout');

assert.deepStrictEqual(vercel.regions, ['fra1'], 'server functions must stay in Frankfurt');
assert.strictEqual(vercel.functions['api/member/training.js'].maxDuration, 120);
assert.strictEqual(vercel.functions['api/member/nutrition.js'].maxDuration, 120);

assert.ok(member.includes('.ernSetupMetrics{display:flex;gap:10px;margin-top:14px}'));
assert.ok(member.includes('@media(max-width:380px)'));
assert.ok(member.includes('grid-template-columns:repeat(2,minmax(0,1fr))'));
assert.ok(member.includes('.ernSetupMetric:last-child{grid-column:1/-1}'));
assert.ok(member.includes('overflow-x:hidden'), 'nutrition onboarding must not overflow horizontally');
assert.ok(
  (member.match(/timeoutMs:120000/g) || []).length >= 4,
  'plan requests must wait for the extended server runtime'
);

assert.ok(member.includes("function finnPlanLoadingView(days,kind)"));
assert.ok(member.includes("function trainingPlanLoadingView(days)"));
assert.ok(member.includes("trainingPlanLoadingView(S.trainGenDays)"));
assert.ok(member.includes("role=\"status\" aria-live=\"polite\" aria-label=\"FINN erstellt deinen Trainingsplan\""));
assert.ok(member.includes("FINN wählt passende Übungen …"));

// ── Android: Kopf klebt an der System-Statusleiste (Samsung) ───────────────────
// env(safe-area-inset-top) meldet auf Android 0 -> --sat=0 -> Kopf nicht antippbar.
// Ein Mindestwert (Floor) NUR im immersiven Android-Kontext (App/Homescreen) hebt
// den Kopf frei, ohne iOS (env korrekt) oder den Browser-Tab zu verändern.
assert.ok(member.includes('function __immersiveTop()'), 'immersive-Erkennung fuer den --sat-Floor muss existieren');
assert.ok(member.includes('function __satFloor()'), '--sat-Floor-Helfer muss existieren');
assert.ok(/__satFloor\(\)\{[\s\S]*?\/Android\/i\.test\(navigator\.userAgent[\s\S]*?__immersiveTop\(\)[\s\S]*?return 28/.test(member),
  'Floor nur fuer Android + immersiv, Wert 28px');
assert.ok(member.includes('return Math.max(v, __satFloor());'), '__satRead muss den Floor anwenden');
assert.ok(member.includes("min(env(safe-area-inset-top,0px), 60px)"), '60px-Deckel bleibt erhalten');

// ── Gewicht-Eintrag auffindbar machen (Rueckmeldung: nicht gefunden) ───────────
// Sichtbare Karte auf der Startseite + Eintrag im „+"-Schnellmenue, beide -> figur.
assert.ok(member.includes('function homeFigurCard()'), 'Startseiten-Karte fuer Gewicht/Maße muss existieren');
assert.ok(member.includes('homeVitalCard()+homeFigurCard()'), 'Gewicht-Karte muss in der Startseite eingehaengt sein');
assert.ok(member.includes("qaRow('figur',"), 'Schnellmenue muss einen Gewicht-Eintrag haben');
assert.ok(/var screens=\[[^\]]*'figur'[^\]]*\];/.test(member), "qaGo muss 'figur' als Ziel kennen");
assert.ok(member.includes("rIf(['figur','home','fort','ern'])"), 'loadFigur muss Home/Fortschritt/Ernaehrung mit-rendern');

// Gewicht auch im Ernaehrungs-Bereich (Verlauf-Tab + Erfassen-"+") – Nutzerwunsch.
assert.ok(member.includes('function ernWeightCard()'), 'Gewicht-Karte im Ernaehrungs-Verlauf muss existieren');
assert.ok(member.includes('return ernWeightCard()+stripCard'), 'Gewicht-Karte muss im Verlauf-Tab oben stehen');
assert.ok(member.includes("mkPick('ernCapWeight',"), 'Ernaehrungs-Erfassen muss einen Gewicht-Eintrag haben');
assert.ok(/ernCapWeight:function\(\)\{[\s\S]*?nav\('figur'\)/.test(member), "ernCapWeight muss in den Figur-Check fuehren");

// ── Android-System-Zurück fängt statt App zu schließen (Rueckmeldung Samsung) ──
// Native App: Capacitor backButton -> doBack(); nur Startseite exitApp.
// Browser/PWA: History-Barriere + popstate -> doBack().
assert.ok(member.includes("addListener('backButton'"), 'Capacitor backButton muss abgefangen werden');
assert.ok(/backButton'[\s\S]*?if\(canBack\(\)\)\{[^}]*doBack\(\)/.test(member), 'backButton muss doBack() nutzen');
assert.ok(/backButton'[\s\S]*?exitApp\(\)/.test(member), 'backButton darf nur am Ende exitApp aufrufen');
assert.ok(member.includes('window.__armBackBarrier'), 'History-Barriere fuer den Browser-Zurueck muss existieren');
assert.ok(member.includes("addEventListener('popstate'"), 'popstate muss den System-Zurueck abfangen');
assert.ok(/popstate'[\s\S]*?if\(canBack\(\)\)\{[^}]*doBack\(\)/.test(member), 'popstate muss doBack() nutzen');
assert.ok((member.match(/if\(window\.__armBackBarrier\) window\.__armBackBarrier\(\)/g) || []).length >= 1,
  'nav() muss die Zurueck-Barriere scharf halten');

// ── System-Zurück darf die App NIE beenden ausser am echten Wurzel-Screen ──
// (Video: Erfassen-Sheet -> Zurück schloss die ganze App). doBack faengt Fehler ab,
// das Erfassen-Sheet wird ueber closeAnyOverlay geschlossen, und der native Listener
// ruft exitApp NICHT mehr im catch auf.
assert.ok(member.includes('function closeAnyOverlay()'), 'Overlay-Fallback muss existieren');
assert.ok(member.includes('if(!closeKnownOverlay()) closeAnyOverlay()'), 'doBack muss Overlays immer schliessen');
assert.ok(/function closeAnyOverlay\(\)\{[\s\S]*?S\.ernCapture[\s\S]*?ernCloseCapture/.test(member), 'closeAnyOverlay muss das Erfassen-Sheet schliessen');
assert.ok(member.includes('try{ atRoot=!canBack(); }catch(e){ atRoot=false; }'), 'backButton: Fehler != Wurzel (kein Exit im Fehlerfall)');
assert.ok(!member.includes('catch(err){ try{ if(AppP.exitApp) AppP.exitApp(); }catch(_e){} }'),
  'backButton darf im catch NICHT mehr exitApp aufrufen');

console.log('android plan fixes test passed');
