'use strict';
// Phasenwechsel-Benachrichtigung (api/nutri-phase-tick): meldet genau EINMAL pro
// Wechsel per Push + Postfach, erinnert das Team bei ausgelaufenem Analyse-Plan
// und lässt Minderjährige unangetastet.
const path=require('path');
const ROOT=path.resolve(__dirname,'..');
const inject=(rel,ex)=>{const p=path.resolve(ROOT,rel);require.cache[p]={id:p,filename:p,loaded:true,exports:ex};};
process.env.RECORD_SECRET='s3cr3t';
const P=require(path.resolve(ROOT,'lib/nutriPhases.js'));
const TODAY=P.berlinToday(), ago=(n)=>P.addDays(TODAY,-n);
const kv=new Map(), sets=new Map();
inject('lib/store.js',{hasStore:true,redisPipeline:async(cmds)=>cmds.map((c)=>{const op=String(c[0]).toUpperCase(),k=String(c[1]);
  if(op==='GET')return kv.has(k)?kv.get(k):null; if(op==='SET'){kv.set(k,c[2]);return 'OK';}
  if(op==='SADD'){if(!sets.has(k))sets.set(k,new Set());sets.get(k).add(String(c[2]));return 1;}
  if(op==='SREM'){if(sets.has(k))sets.get(k).delete(String(c[2]));return 1;}
  if(op==='SMEMBERS')return sets.has(k)?Array.from(sets.get(k)):[]; return 0;})});
const pushes=[], vorgaenge=[], studio=[];
inject('lib/push.js',{hasPush:true,notifyMember:async(id,cat,msg)=>{pushes.push({id,cat,msg});return{ok:true};}});
inject('lib/inbox.js',{addVorgang:async(id,o)=>{vorgaenge.push({id,o});return{id:'1'};}});
inject('lib/studioReply.js',{notifyStudio:async(o)=>{studio.push(o);}});
inject('lib/members.js',{getMember:async()=>({firstName:'Max',lastName:'M'})});
inject('lib/cronAuth.js',{requireCronAuth:()=>true});
const H=require(path.resolve(ROOT,'api/nutri-phase-tick.js'));
const mkPlan=(start,source)=>({v:1,startDate:start,source:source||'team',phases:[
  {key:'p1',name:'Aktivierung',kind:'aktivierung',weeks:6,kcal:2400,protein:160,carbs:250,fat:80,note:''},
  {key:'p2',name:'Reduktion',kind:'reduktion',weeks:8,kcal:2000,protein:180,carbs:170,fat:70,note:'Dranbleiben!'}],
  lastPhaseKey:'p1'});
const setM=(id,age,plan)=>kv.set('nutri:p:'+id,JSON.stringify({age:age,phasePlan:plan}));
const idx=(id)=>{if(!sets.has('nutri:phidx'))sets.set('nutri:phidx',new Set());sets.get('nutri:phidx').add(id);};
async function run(){
  let pass=true;const ok=(l,c,e)=>{if(!c)pass=false;console.log((c?'OK  ':'FAIL')+' '+l+(c?'':' -- '+(e||'')));};
  // Mitglied 1: mitten in Phase 1 -> kein Wechsel
  setM('m1',30,mkPlan(ago(10))); idx('m1');
  // Mitglied 2: Tag 45 -> Phase 2, lastPhaseKey noch p1 -> Wechsel
  setM('m2',30,mkPlan(ago(45))); idx('m2');
  // Mitglied 3: minderjährig -> nie benachrichtigen
  setM('m3',16,mkPlan(ago(45))); idx('m3');
  let r=await H.run();
  ok('1. genau ein Wechsel erkannt',r.switched===1,JSON.stringify(r));
  ok('2. Push ging an das richtige Mitglied',pushes.length===1&&pushes[0].id==='m2',JSON.stringify(pushes.map(p=>p.id)));
  ok('3. Push nennt die neue Phase, aber keine Zahlen',/Reduktion/.test(pushes[0].msg.title)&&!/\d{4}/.test(pushes[0].msg.body||''),JSON.stringify(pushes[0].msg));
  ok('4. Postfach-Nachricht mit Werten + Team-Notiz',vorgaenge.length===1&&/Reduktion/.test(vorgaenge[0].o.subject)&&/2000 kcal/.test(vorgaenge[0].o.systemText)&&/Dranbleiben/.test(vorgaenge[0].o.systemText),JSON.stringify(vorgaenge[0]&&vorgaenge[0].o.subject));
  ok('5. Postfach-Vorgang alarmiert das Team nicht',vorgaenge[0].o.teamUnread===false&&vorgaenge[0].o.status==='abgeschlossen');
  ok('6. Minderjährige bleiben unberührt',!pushes.some(p=>p.id==='m3')&&!vorgaenge.some(v=>v.id==='m3'));
  // Zweiter Lauf: kein Doppel-Versand
  r=await H.run();
  ok('7. zweiter Lauf meldet nichts erneut',r.switched===0&&pushes.length===1&&vorgaenge.length===1,JSON.stringify(r));
  // Analyse-Plan ausgelaufen -> Team-Hinweis, genau einmal
  setM('m4',30,Object.assign(mkPlan(ago(200),'analysis'),{lastPhaseKey:'p2'})); idx('m4');
  r=await H.run();
  ok('8. ausgelaufener Analyse-Plan -> Team-Hinweis',studio.length===1&&/ausgelaufen/i.test(studio[0].subject),JSON.stringify(studio.map(s=>s.subject)));
  r=await H.run();
  ok('9. Team-Hinweis kommt nur einmal',studio.length===1);
  ok('10. Mitglied bekam dafür keinen Push',!pushes.some(p=>p.id==='m4'));
  console.log(pass?'NUTRI-PHASE-TICK PASS':'NUTRI-PHASE-TICK FAIL');process.exit(pass?0:1);
}
run().catch(e=>{console.error('FAIL',e);process.exit(1);});
