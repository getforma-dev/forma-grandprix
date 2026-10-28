import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createGitHub, dispatchPlan, REPOSITORY, runCommand, SAFE_EXTRACT } from '../src/github.mjs';
import { readJSON, seal, verify, writeJSON } from '../src/session.mjs';
const sha = 'a'.repeat(40);
function fixture(t) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'gp-github-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 writeJSON(path.join(root,'config/laboratory.json'),{currentForma:{sourceCommit:sha},suites:{server:{cars:['forma','react-node']},islands:{cars:['forma','react-node']}}});return root;
}
function zipTree(root,dest) { execFileSync('python3',['-c',"import pathlib,sys,zipfile\nroot=pathlib.Path(sys.argv[1])\nwith zipfile.ZipFile(sys.argv[2],'w') as z:\n for f in root.rglob('*'):\n  if f.is_file():z.write(f,f.relative_to(root))",root,dest]); }
function remoteFixture(t, mutate=()=>{}) {
 const root=fixture(t), original=path.join(root,'source'), zip=path.join(root,'source.zip');
 const manifest={schemaVersion:1,id:'remote-test',status:'failed',quality:'unqualified',startedAt:'2026-10-26T12:00:00Z',finishedAt:'2026-10-26T12:01:00Z',source:{commit:sha},labSourceCommit:sha,formaSourceCommits:['b'.repeat(40)],config:{suite:'client'},expected:[{trial:'artifacts/trial-a',event:'dom',car:'forma'}],remote:{repository:REPOSITORY,runId:'123',runAttempt:'1'}};
 mutate(manifest);writeJSON(path.join(original,'manifest.json'),manifest);fs.writeFileSync(path.join(original,'run.log'),'preserved preparation failure');seal(original);zipTree(original,zip);
 const run={id:123,run_attempt:1,status:'completed',conclusion:'failure',path:'.github/workflows/grand-prix-client.yml',head_sha:sha,created_at:manifest.startedAt,updated_at:manifest.finishedAt,html_url:'https://github.com/'+REPOSITORY+'/actions/runs/123'};
 const artifact={id:456,name:'grand-prix-client-123-1',expired:false,size_in_bytes:fs.statSync(zip).size,workflow_run:{id:123}};
 const calls=[];const command=async(program,args,options)=>{calls.push([program,args,options]);if(program==='python3')return runCommand(program,args,options);assert.equal(program,'gh');if(args[1].endsWith('/artifacts/456/zip')){fs.copyFileSync(zip,options.outputFile);return{stdout:''};}return {stdout:JSON.stringify(args[1].includes('/artifacts?')?{artifacts:[artifact]}:run)};};
 return{root,original,manifest,run,artifact,zip,calls,client:createGitHub(root,{command})};
}
test('dispatch defaults full server grid with exact source, bounded hosted profile, no shell fragments',t=>{
 const root=fixture(t),plan=dispatchPlan(root,{suite:'server'});assert.equal(plan.fields.cars,'forma,react-node');assert.equal(plan.fields.events,'1,2,3,4,5,6,7,8');assert.equal(plan.fields.forma_ref,sha);assert.equal(plan.fields.profile,'gha-4-v1');assert.equal(plan.fields.diagnostic,'false');
 const subset=dispatchPlan(root,{suite:'server',cars:['react-node'],events:[8,1]});assert.equal(subset.fields.events,'1,8');assert.equal(subset.fields.cars,'react-node');
 for(const input of [{suite:'oops'},{suite:'server',events:[0]},{suite:'server',cars:['forma; touch bad']},{suite:'server',formaRef:'main'},{suite:'server',formaRef:'a'.repeat(40)+','+'b'.repeat(40)},{suite:'client',events:[1]},{suite:'islands',formaRef:sha},{suite:'server',workflowRef:'a/../main'},{suite:'server',profile:'native-8-v1'},{suite:'server',diagnostic:'false'},{suite:'server',unexpected:1}])assert.throws(()=>dispatchPlan(root,input));
});
test('dispatch uses structured gh stdin and private account access does not return a token',async t=>{
 const root=fixture(t),calls=[];const github=createGitHub(root,{command:async(program,args,options)=>{calls.push([program,args,options]);return{stdout:args[0]==='workflow'?'https://github.com/'+REPOSITORY+'/actions/runs/123':'tester\n'};}});
 const result=await github.dispatch({suite:'paired',formaRefs:sha});assert.equal(result.runUrl,'https://github.com/'+REPOSITORY+'/actions/runs/123');assert.deepEqual(calls[0][1],['workflow','run','grand-prix-paired.yml','--repo',REPOSITORY,'--ref','main','--json']);assert.equal(JSON.parse(calls[0][2].input).forma_refs,sha);assert.equal((await github.account()).login,'tester');
});
test('import retains failed remote evidence, its source identity, original time and prefixed trial identity',async t=>{
 const f=remoteFixture(t),result=await f.client.importRun(123,()=>{},1),dir=path.join(f.root,'runs',result.id),manifest=readJSON(path.join(dir,'manifest.json'));
 assert.equal(manifest.originalStatus,'failed');assert.equal(manifest.originalQuality,'unqualified');assert.equal(manifest.observedAt,f.manifest.startedAt);assert.equal(manifest.remote.originalManifest.expected[0].trial,'artifacts/trial-a');assert.equal(manifest.expected[0].trial,'artifacts/remote/artifacts/trial-a');assert.equal(manifest.labSourceCommit,sha);assert.equal(manifest.formaSourceCommits[0],'b'.repeat(40));assert.equal(verify(dir).ok,true);assert.equal(fs.readFileSync(path.join(dir,'artifacts/remote/run.log'),'utf8'),'preserved preparation failure');assert(fs.existsSync(path.join(dir,'original.zip')));assert(!fs.existsSync(path.join(f.root,'.grandprix/active.json')));assert.equal((await f.client.importRun(123)).reused,true);
});
test('tampered repository, run, attempt and source identities fail closed and preserve raw archive',async t=>{
 for(const mutate of [m=>m.remote.repository='other/repo',m=>m.remote.runId='999',m=>m.remote.runAttempt='2',m=>delete m.remote,m=>m.source.commit='c'.repeat(40),m=>delete m.labSourceCommit]){
  const f=remoteFixture(t,mutate);await assert.rejects(f.client.importRun(123),/identity differs|source differs/);const dir=path.join(f.root,'runs/github-123-1-456');assert.equal(readJSON(path.join(dir,'manifest.json')).status,'failed');assert(fs.existsSync(path.join(dir,'original.zip')));assert.equal(verify(dir).ok,true);assert(!fs.existsSync(path.join(f.root,'.grandprix/active.json')));
 }
});
test('current attempt must match selected attempt; failed import retries never overwrite retained evidence',async t=>{
 const f=remoteFixture(t,m=>m.remote.runId='wrong');await assert.rejects(f.client.importRun(123,()=>{},2),/attempt changed/);assert(!fs.existsSync(path.join(f.root,'runs')));
 await assert.rejects(f.client.importRun(123),/identity differs/);await assert.rejects(f.client.importRun(123),/identity differs/);const dirs=fs.readdirSync(path.join(f.root,'runs'));assert.equal(dirs.length,2);assert(dirs.some(name=>name.includes('-retry-')));
});
test('artifact ownership and advertised hash checked before extracted evidence is trusted',async t=>{
 const f=remoteFixture(t);f.artifact.workflow_run.id=9;await assert.rejects(f.client.importRun(123),/another workflow/);f.artifact.workflow_run.id=123;f.artifact.digest='sha256:'+'0'.repeat(64);await assert.rejects(f.client.importRun(123),/digest/);assert(!fs.existsSync(path.join(f.root,'.grandprix/active.json')));
});
test('archive extractor rejects traversal, absolute paths, duplicate members and symlinks',async t=>{
 const root=fixture(t);let index=0;
 for(const [name,duplicate,symlink] of [['../escape',false,false],['/absolute',false,false],['a/../b',false,false],['a\\b',false,false],['normal',true,false],['link',false,true]]){
  const zip=path.join(root,`unsafe-${index}.zip`),out=path.join(root,`out-${index++}`);fs.mkdirSync(out);
  execFileSync('python3',['-c',"import zipfile,sys,stat\nz=zipfile.ZipFile(sys.argv[1],'w');i=zipfile.ZipInfo(sys.argv[2]);i.external_attr=((stat.S_IFLNK|0o777)<<16) if sys.argv[4]=='true' else ((stat.S_IFREG|0o644)<<16);z.writestr(i,'data');\nif sys.argv[3]=='true':z.writestr(i,'duplicate')\nz.close()",zip,name,String(duplicate),String(symlink)],{stdio:'ignore'});
  await assert.rejects(runCommand('python3',['-c',SAFE_EXTRACT,zip,out]),/unsafe|duplicate|special/);assert.equal(fs.readdirSync(out).length,0);
 }
});
test('subprocess runner bounds output and duration without invoking a shell',async()=>{
 const result=await runCommand(process.execPath,['-e','process.stdout.write(process.argv[1])','$(touch never)']);assert.equal(result.stdout,'$(touch never)');
 await assert.rejects(runCommand(process.execPath,['-e','process.stdout.write("x".repeat(10000))'],{maxBytes:10}),/output limit/);
 await assert.rejects(runCommand(process.execPath,['-e','setInterval(()=>{},1000)'],{timeout:30}),/time limit/);
});
test('workflow detail supplies exact follow identity without exposing account credentials',async t=>{
 const root=fixture(t),run={id:123,run_attempt:2,path:'.github/workflows/grand-prix.yml',head_sha:sha,repository:{full_name:REPOSITORY},status:'in_progress',html_url:`https://github.com/${REPOSITORY}/actions/runs/123`};
 const github=createGitHub(root,{command:async(program,args)=>({stdout:JSON.stringify(args[1].includes('/jobs?')?{jobs:[]}:run)})});const detail=await github.detail(123);assert.equal(detail.attempt,2);assert.equal(detail.workflow,run.path);assert.equal(detail.headSha,sha);assert.equal(detail.repository,REPOSITORY);assert.deepEqual(detail.jobs,[]);
});
