import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { startControlServer } from '../src/control-server.mjs';
import { writeJSON } from '../src/session.mjs';
const sha='a'.repeat(40);
async function fixture(t, overrides={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'gp-control-'));const put=(file,value)=>{const dest=path.join(root,file);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,typeof value==='string'?value:JSON.stringify(value));};
 put('config/laboratory.json',{currentForma:{sourceCommit:sha},suites:{server:{cars:['forma','react-node']},islands:{cars:['forma']}}});put('config/change-ledger.json',{changes:[]});for(const file of ['index.html','app.js','styles.css'])put('web/'+file,'test '+file);put('docs/method.md','readable methods');put('runs/kept/report.html','retained report');put('runs/kept/manifest.json',{id:'kept',status:'imported',quality:'remote-import',originalStatus:'failed',originalQuality:'unqualified',startedAt:'2026-10-20',config:{suite:'client'}});
 const calls=[],runs=[];const github={account:async()=>({connected:true,login:'tester'}),runs:async()=>runs,detail:async id=>({id,jobs:[]}),dispatch:async input=>{calls.push(['dispatch',input]);return {requestId:'local-request',autoImport:input.autoImport!==false};},importRun:async(id,progress,attempt)=>{calls.push(['import',String(id),attempt]);return{id:'imported-'+id,report:'/runs/imported/report.html'};},...overrides};
 const command=async(program,args)=>{calls.push(['command',program,args]);return{stdout:'test prerequisite output'};};const app=await startControlServer({root,port:0,github,command});await app.accountReady;
 t.after(async()=>{await app.close();fs.rmSync(root,{recursive:true,force:true});});
 const get=async url=>(await fetch(app.url+url)).json();const state=await get('/api/state');
 const post=(url,input,headers={})=>fetch(app.url+url,{method:'POST',headers:{Origin:app.url,'Content-Type':'application/json','X-GrandPrix-CSRF':state.csrf,...headers},body:JSON.stringify(input)});
 return {root,put,app,calls,runs,state,get,post};
}
async function settled(f,id){for(let i=0;i<50;i++){const task=await f.get('/api/tasks/'+id);if(['completed','failed'].includes(task.status))return task;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Task did not settle');}
test('control desk listens only on loopback and starts no measurement or dispatch',async t=>{
 const f=await fixture(t);assert.equal(f.app.server.address().address,'127.0.0.1');assert.equal(f.calls.length,0);assert.equal(f.state.history[0].originalStatus,'failed');assert.equal(f.state.history[0].originalQuality,'unqualified');assert.match(f.state.csrf,/^[a-f0-9]{64}$/);
 const page=await fetch(f.app.url);assert.equal(page.status,200);assert.match(page.headers.get('content-security-policy'),/script-src 'self'/);assert.equal(page.headers.get('access-control-allow-origin'),null);await page.text();
});
test('all mutations require exact local Origin, host and CSRF token',async t=>{
 const f=await fixture(t);for(const headers of [{Origin:'https://hostile.test'},{Origin:'null'},{'X-GrandPrix-CSRF':''},{'Sec-Fetch-Site':'cross-site'}])assert.equal((await f.post('/api/dispatch',{suite:'server'},headers)).status,403,JSON.stringify(headers));
 const hostile = await new Promise((resolve,reject)=>{const req=http.request(f.app.url+'/api/state',{headers:{Host:'hostile.test'}},response=>{response.resume();resolve(response.statusCode);});req.on('error',reject);req.end();});assert.equal(hostile,403);
 assert.equal(f.calls.length,0);const response=await f.post('/api/dispatch',{suite:'server',events:[0]});assert.equal(response.status,400);assert.equal(f.calls.length,0);
 const accepted=await f.post('/api/dispatch',{suite:'server',cars:['forma'],events:[1],autoImport:false});assert.equal(accepted.status,202);assert.equal((await settled(f,(await accepted.json()).id)).status,'completed');assert.equal(f.calls.filter(call=>call[0]==='dispatch').length,1);
});
test('reports are isolated from control page scripts and evidence paths reject symlinks',async t=>{
 const f=await fixture(t);const report=await fetch(f.app.url+'/runs/kept/report.html');assert.equal(report.status,200);assert.match(report.headers.get('content-security-policy'),/sandbox allow-scripts/);assert(!report.headers.get('content-security-policy').includes('allow-same-origin'));
 assert.equal((await fetch(f.app.url+'/docs/method.md')).status,200);f.put('runs/kept/other.html','untrusted');assert.equal((await fetch(f.app.url+'/runs/kept/other.html')).status,400);
 fs.symlinkSync(path.join(f.root,'config'),path.join(f.root,'runs/escaped'));assert.equal((await fetch(f.app.url+'/runs/escaped/laboratory.json')).status,400);assert.equal((await fetch(f.app.url+'/runs/%2e%2e%2fconfig/laboratory.json')).status,400);
});
test('local controls verify named evidence, separate prerequisites from Linux, and require explicit diagnostic consent/dependencies',async t=>{
 const f=await fixture(t);assert.equal((await f.post('/api/local',{action:'diagnostic'})).status,400);const diagnostic=await f.post('/api/local',{action:'diagnostic',confirmDiagnostic:true});assert.equal(diagnostic.status,400);assert.match((await diagnostic.json()).error,/npm ci --prefix signals-race --ignore-scripts/);
 assert.equal((await f.post('/api/local',{action:'verify',id:'../escape'})).status,400);const verified=await f.post('/api/local',{action:'verify',id:'kept'});await settled(f,(await verified.json()).id);assert.deepEqual(f.calls.find(call=>call[0]==='command')[2].slice(-2),['verify','kept']);
 const doctor=await f.post('/api/local',{action:'doctor'});const completed=await settled(f,(await doctor.json()).id);assert.equal(completed.status,'completed');assert.match(completed.result.output,/Docker and Linux are not required/);assert(!f.calls.some(call=>call[2]?.includes('doctor')));
});
test('an active or interrupted run blocks dispatch, local controls and evidence import',async t=>{
 const f=await fixture(t);f.put('.grandprix/active.json',{pid:1,runId:'owned'});assert.equal((await f.post('/api/dispatch',{suite:'server'})).status,400);assert.equal((await f.post('/api/local',{action:'doctor'})).status,400);
 const task=await(await f.post('/api/import',{runId:123,attempt:1})).json();assert.equal((await settled(f,task.id)).status,'failed');assert.equal(f.calls.length,0);
});
test('completed rerun attempts remain importable; the same attempt is deduplicated',async t=>{
 const f=await fixture(t);const one=await(await f.post('/api/import',{runId:123,attempt:1})).json();await settled(f,one.id);const duplicate=await(await f.post('/api/import',{runId:123,attempt:1})).json();assert.equal(one.id,duplicate.id);
 const two=await(await f.post('/api/import',{runId:123,attempt:2})).json();await settled(f,two.id);assert.notEqual(two.id,one.id);assert.deepEqual(f.calls.filter(call=>call[0]==='import'),[['import','123',1],['import','123',2]]);
});
test('automatic import only follows an explicit dispatch with capture enabled',async t=>{
 const f=await fixture(t);f.runs.push({id:123,attempt:1,title:'Grand Prix · local-request',status:'completed'});await f.app.refreshRemote(true);assert.equal(f.calls.length,0);
 const dispatched=await(await f.post('/api/dispatch',{suite:'server',autoImport:true})).json();await settled(f,dispatched.id);await f.app.refreshRemote(true);const state=await f.get('/api/state');const imported=state.tasks.find(task=>task.kind==='import');assert(imported);await settled(f,imported.id);assert.equal(f.calls.filter(call=>call[0]==='import').length,1);await f.app.refreshRemote(true);assert.equal(f.calls.filter(call=>call[0]==='import').length,1);
});
test('restart marks unfinished control operations interrupted and never replays them',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'gp-control-restart-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const id='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';writeJSON(path.join(root,'.grandprix/control-tasks',id+'.json'),{id,kind:'dispatch',status:'running',createdAt:'2026-10-20'});let calls=0;
 const app=await startControlServer({root,port:0,github:{account:async()=>({connected:false}),runs:async()=>{calls++;return[];}}});await app.accountReady;const task=await(await fetch(app.url+'/api/tasks/'+id)).json();assert.equal(task.status,'interrupted');assert.equal(calls,0);await app.close();
});
