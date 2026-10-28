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
test('archive restoration rejects arbitrary paths, extra inputs and cross-origin requests before queueing',async t=>{
 const f=await fixture(t);
 for(const input of [{catalog:'../archive.zip'},{catalog:'https://example.test/archive.json'},{catalog:'evidence/catalog/1-1-1.json',url:'https://example.test'}])assert.equal((await f.post('/api/restore',input)).status,400);
 assert.equal((await f.post('/api/restore',{catalog:'evidence/catalog/1-1-1.json'},{Origin:'https://example.test'})).status,403);
 f.put('.grandprix/active.json',{pid:1,runId:'owned'});assert.equal((await f.post('/api/restore',{catalog:'evidence/catalog/1-1-1.json'})).status,400);
 assert.equal(f.calls.length,0);assert.equal((await f.get('/api/state')).tasks.length,0);
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
function catalogRecord(runId=123){
 const repository='getforma-dev/forma-grandprix',tag='evidence-'+runId,name='grand-prix-server-'+runId+'-1.zip';
 return{schemaVersion:1,kind:'forma-grand-prix-evidence-archive',observedAt:'2026-10-28T12:00:00Z',publishedAt:'2026-10-28T13:00:00Z',suite:'server',status:'failed',quality:'qualified',remote:{repository,runId:String(runId),attempt:'1',artifactId:'456',url:`https://github.com/${repository}/actions/runs/${runId}/attempts/1`},archive:{sha256:'a'.repeat(64),bytes:1000,format:'original-github-actions-zip'},source:{laboratoryCommit:'a'.repeat(40),formaCommits:['b'.repeat(40)],originalManifestSha256:'c'.repeat(64),originalSealSha256:'d'.repeat(64)},release:{id:789,tag,url:`https://github.com/${repository}/releases/tag/${tag}`},asset:{id:987,name,url:`https://github.com/${repository}/releases/download/${tag}/${name}`}};
}
test('a malformed catalog record cannot take down good archives or retained history',async t=>{
 const f=await fixture(t);f.put('evidence/catalog/123-1-456.json',catalogRecord());f.put('evidence/catalog/124-1-456.json','{invalid json');
 const response=await fetch(f.app.url+'/api/state');assert.equal(response.status,200);const state=await response.json();assert.equal(state.catalog.length,1);assert.equal(state.catalog[0].remote.runId,'123');assert.equal(state.history[0].id,'kept');assert.equal(state.history[0].originalStatus,'failed');assert.equal(state.catalogErrors.length,1);assert.equal(state.catalogErrors[0].path,'evidence/catalog/124-1-456.json');assert(state.catalogErrors[0].error);
});
test('public catalog envelope rejects missing identity, unsafe URLs, bad hashes and sizes independently',async t=>{
 const f=await fixture(t);const changes=[r=>r.schemaVersion=2,r=>delete r.remote,r=>r.remote.runId='different',r=>r.asset.url='javascript:alert(1)',r=>r.remote.url='https://github.com/other/repo/actions/runs/123',r=>r.archive.sha256='short',r=>r.archive.bytes=-1,r=>r.archive.bytes='100',r=>r.source.formaCommits=[null],r=>delete r.release,r=>r.observedAt='nonsense'];
 changes.forEach((change,index)=>{const record=catalogRecord(200+index);change(record);f.put(`evidence/catalog/${200+index}-1-456.json`,record);});f.put('evidence/catalog/123-1-456.json',catalogRecord());
 const state=await f.get('/api/state');assert.equal(state.catalog.length,1);assert.equal(state.catalogErrors.length,changes.length);assert.equal(state.history.length,1);assert(state.catalogErrors.every(error=>error.path&&error.error));
});
test('catalog filesystem problems are reported without breaking the control state',async t=>{
 const f=await fixture(t);f.put('evidence/catalog/123-1-456.json',catalogRecord());fs.symlinkSync(path.join(f.root,'config/laboratory.json'),path.join(f.root,'evidence/catalog/124-1-456.json'));const state=await f.get('/api/state');assert.equal(state.catalog.length,1);assert.match(state.catalogErrors[0].error,/Symlink refused/);
 fs.rmSync(path.join(f.root,'evidence/catalog'),{recursive:true});fs.symlinkSync(path.join(f.root,'config'),path.join(f.root,'evidence/catalog'));const damaged=await f.get('/api/state');assert.equal(damaged.catalog.length,0);assert.equal(damaged.catalogErrors[0].path,'evidence/catalog');assert.equal(damaged.history.length,1);
});
function followedRun(changes={}){return{id:123,attempt:1,workflow:'.github/workflows/grand-prix.yml',headSha:sha,repository:'getforma-dev/forma-grandprix',url:'https://github.com/getforma-dev/forma-grandprix/actions/runs/123',status:'in_progress',conclusion:null,jobs:[],...changes};}
test('follow validates an existing exact attempt, deduplicates it, and imports completion without dispatch',async t=>{
 const run=followedRun(),f=await fixture(t,{detail:async()=>({...run})});
 const response=await f.post('/api/follow',{runId:123,attempt:1});assert.equal(response.status,202);const follow=await response.json();assert.equal(follow.kind,'follow');assert.equal(follow.status,'watching');assert.equal(follow.result.headSha,sha);assert.equal(follow.input.runId,'123');
 const duplicate=await(await f.post('/api/follow',{runId:123,attempt:1})).json();assert.equal(duplicate.id,follow.id);await f.app.refreshRemote(true);assert.equal(f.calls.length,0);
 run.status='completed';run.conclusion='failure';await f.app.refreshRemote(true);const watching=await f.get('/api/tasks/'+follow.id);assert(watching.importScheduled);await settled(f,watching.importScheduled);await f.app.refreshRemote(true);const done=await f.get('/api/tasks/'+follow.id);assert.equal(done.status,'completed');assert.equal(done.remoteConclusion,'failure');assert.deepEqual(f.calls,[['import','123',1]]);assert(done.result.report);
});
test('follow refuses wrong attempts, unknown workflows, foreign repositories and missing exact source',async t=>{
 for(const changes of [{attempt:2},{workflow:'.github/workflows/unknown.yml'},{repository:'other/repo'},{headSha:'main'},{id:456},{url:'https://github.com/other/repo/actions/runs/123'}]){
  const f=await fixture(t,{detail:async()=>followedRun(changes)});const response=await f.post('/api/follow',{runId:123,attempt:1});assert.equal(response.status,400,JSON.stringify(changes));assert.equal(f.calls.length,0);assert.equal((await f.get('/api/state')).tasks.length,0);
 }
});
test('a followed rerun or source mismatch fails visibly and never switches the imported attempt',async t=>{
 for(const changes of [{attempt:2},{headSha:'b'.repeat(40)}]){
  const run=followedRun(),f=await fixture(t,{detail:async()=>({...run})});const follow=await(await f.post('/api/follow',{runId:123,attempt:1})).json();Object.assign(run,changes,{status:'completed'});await f.app.refreshRemote(true);const task=await f.get('/api/tasks/'+follow.id);assert.equal(task.status,'failed');assert.match(task.error,/attempt changed|source changed/);assert.equal(task.input.attempt,1);assert.equal(f.calls.length,0);
 }
});
test('following persists across server restart and works outside the recent workflow list',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'gp-follow-restart-'));writeJSON(path.join(root,'config/laboratory.json'),{suites:{}});let imports=0;const run=followedRun();const github={account:async()=>({connected:true}),runs:async()=>[],detail:async()=>({...run}),importRun:async(id,progress,attempt)=>{assert.equal(id,'123');assert.equal(attempt,1);imports++;return{id:'kept-follow'};}};
 let app=await startControlServer({root,port:0,github});t.after(async()=>{await app.close();fs.rmSync(root,{recursive:true,force:true});});await app.accountReady;const state=await(await fetch(app.url+'/api/state')).json();const response=await fetch(app.url+'/api/follow',{method:'POST',headers:{Origin:app.url,'Content-Type':'application/json','X-GrandPrix-CSRF':state.csrf},body:JSON.stringify({runId:123,attempt:1})});const follow=await response.json();assert.equal(follow.status,'watching');await app.close();
 app=await startControlServer({root,port:0,github});await app.accountReady;let task=await(await fetch(app.url+'/api/tasks/'+follow.id)).json();assert.equal(task.status,'watching');assert.equal(imports,0);run.status='completed';await app.refreshRemote(true);await new Promise(resolve=>setTimeout(resolve,10));await app.refreshRemote(true);task=await(await fetch(app.url+'/api/tasks/'+follow.id)).json();assert.equal(task.status,'completed');assert.equal(imports,1);await app.refreshRemote(true);assert.equal(imports,1);
});
test('follow retries temporary read failures and waits for the local laboratory before importing',async t=>{
 let fail=false;const run=followedRun(),f=await fixture(t,{detail:async()=>{if(fail)throw Error('temporary API outage');return{...run};}});const follow=await(await f.post('/api/follow',{runId:123,attempt:1})).json();fail=true;await f.app.refreshRemote(true);let task=await f.get('/api/tasks/'+follow.id);assert.equal(task.status,'watching');assert.match(task.error,/retry/);assert.equal(f.calls.length,0);
 fail=false;run.status='completed';f.put('.grandprix/active.json',{pid:1,runId:'another'});await f.app.refreshRemote(true);task=await f.get('/api/tasks/'+follow.id);assert.equal(task.status,'watching');assert.match(task.error,/will wait/);assert.equal(f.calls.length,0);fs.unlinkSync(path.join(f.root,'.grandprix/active.json'));await f.app.refreshRemote(true);task=await f.get('/api/tasks/'+follow.id);await settled(f,task.importScheduled);assert.equal(f.calls.length,1);
});
