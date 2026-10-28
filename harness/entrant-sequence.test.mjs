import test from 'node:test';
import assert from 'node:assert/strict';
import { runEntrantSequence, assertOwnedEntrantImage, assertEntrantRaceFailure } from './entrant-sequence.mjs';
const failed = (message='entrant failed') => Object.assign(new Error(message), { exitCode: 1 });
const campaign = { id: 'campaign-one' };
const receipt = (car='next') => ({ runId:'run-one', cars:[car], campaign, finished:'2026-10-28T12:00:00Z', failures:[{car,event:2,error:'invalid oha sizePerRequest'}] });
test('first entrant race failure is retained, cleaned, and followed by every remaining entrant sequentially',async()=>{
 const log=[],snapshots=[];let active=0;const reports={};
 const result=await runEntrantSequence({cars:['next','react-router','astro'],beforeEach:async car=>{assert.equal(active,0);log.push('preflight:'+car);},execute:async(car,phase,step)=>{active++;assert.equal(active,1);phase('build');log.push('build:'+car);await Promise.resolve();phase('race');log.push('race:'+car);reports[car]=car==='next'?receipt(car):{passed:true};step.raceReceipt=car+'.json';if(car==='next')throw failed();},cleanup:async car=>{log.push('cleanup:'+car);active--;},recoverable:async(error,step)=>{assertEntrantRaceFailure(reports[step.car],step.car,'run-one',campaign);return error.exitCode===1;},onStep:step=>snapshots.push(structuredClone(step))});
 assert.equal(result.passed,false);assert.equal(result.aborted,false);assert.deepEqual(result.skippedCars,[]);assert.deepEqual(result.steps.map(step=>[step.car,step.status,step.cleanup.completed]),[['next','failed',true],['react-router','completed',true],['astro','completed',true]]);assert.equal(result.failures.length,1);assert.equal(result.failures[0].raceReceipt,'next.json');assert.deepEqual(log,['preflight:next','build:next','race:next','cleanup:next','preflight:react-router','build:react-router','race:react-router','cleanup:react-router','preflight:astro','build:astro','race:astro','cleanup:astro']);assert(snapshots.some(step=>step.car==='next'&&step.error));
});
test('a partial build failure receives cleanup before the next entrant builds',async()=>{
 const log=[];const result=await runEntrantSequence({cars:['broken','eligible'],beforeEach:async()=>{},execute:async(car,phase)=>{phase('build');log.push('build:'+car);if(car==='broken')throw failed('compiler rejected the entrant');},cleanup:async car=>{log.push('remove-owned-runtime:'+car);log.push('remove-owned-build:'+car);},recoverable:async(error,step)=>step.phase==='build'&&error.exitCode===1});
 assert.equal(result.passed,false);assert.equal(result.aborted,false);assert.deepEqual(log,['build:broken','remove-owned-runtime:broken','remove-owned-build:broken','build:eligible','remove-owned-runtime:eligible','remove-owned-build:eligible']);
});
test('fatal host preflight, interruption and cleanup failures stop all later entrants',async()=>{
 for(const failure of ['host','interrupted','cleanup']){
  const log=[];const result=await runEntrantSequence({cars:['first','must-not-run'],beforeEach:async()=>{if(failure==='host')throw Error('resource profile changed');},execute:async(car,phase)=>{log.push('execute:'+car);phase('race');if(failure==='interrupted')throw Object.assign(failed(),{signal:'SIGTERM'});},cleanup:async car=>{log.push('cleanup:'+car);if(failure==='cleanup')throw Error('cannot remove owned image');},recoverable:async()=>false});
  assert.equal(result.passed,false);assert.equal(result.aborted,true);assert.deepEqual(result.skippedCars,['must-not-run']);assert(log.includes('cleanup:first'));assert(!log.some(entry=>entry.endsWith('must-not-run')));
 }
});
test('a failed continuation safety check aborts even an otherwise recoverable build failure',async()=>{
 const result=await runEntrantSequence({cars:['first','later'],beforeEach:async()=>{},execute:async(car,phase)=>{phase('build');throw failed();},cleanup:async()=>{},recoverable:async()=>{throw Error('source commit changed');}});assert.equal(result.aborted,true);assert.match(result.error,/source commit changed/);assert.deepEqual(result.skippedCars,['later']);assert.equal(result.steps[0].cleanup.completed,true);
});
test('matching entrant receipt permits transport failures but refuses global/resource/identity ambiguity',()=>{
 assert.doesNotThrow(()=>assertEntrantRaceFailure(receipt(),'next','run-one',campaign));
 for(const mutate of [r=>r.runId='other',r=>r.cars=['astro'],r=>r.campaign={id:'other'},r=>delete r.finished,r=>r.failures=[],r=>r.failures=[{error:'unknown fatal'}],r=>r.failures[0].car='astro',r=>r.failures[0].error='CPU affinity drift',r=>r.failures[0].error='memory quota drift',r=>r.failures[0].error='host resource profile changed']){const value=receipt();mutate(value);assert.throws(()=>assertEntrantRaceFailure(value,'next','run-one',campaign));}
});
test('image cleanup requires the exact entrant tag and both run ownership labels',()=>{
 const tag='gp264/run-one/next';const image={Id:'sha256:'+'a'.repeat(64),RepoTags:[tag+':latest'],Config:{Labels:{grandprix:'forma-264',gp264run:'run-one'}}};assert.doesNotThrow(()=>assertOwnedEntrantImage(image,tag,'run-one'));
 for(const change of [value=>value.Config.Labels.gp264run='another-run',value=>delete value.Config.Labels.grandprix,value=>value.RepoTags=['gp264/run-one/astro:latest'],value=>value.Id='short']){const value=structuredClone(image);change(value);assert.throws(()=>assertOwnedEntrantImage(value,tag,'run-one'));}
});
test('all passing entrants finish without changing timing or measuring concurrently',async()=>{
 const result=await runEntrantSequence({cars:['one','two'],beforeEach:async()=>{},execute:async(car,phase)=>phase('race'),cleanup:async()=>{},recoverable:async()=>false});assert.equal(result.passed,true);assert.equal(result.failures.length,0);assert.equal(result.aborted,false);
});

test('actual container and process resource refusal messages are fatal across all guard spellings',()=>{
 for(const message of ['container CPU quota differs','container memory quota differs','container CPU affinity differs','browser process affinity differs','missing or duplicate process CPU affinity','recorded process affinity required','invalid CPU affinity list','CPU affinity list is empty or too large','CPU quota drift','memory quota drift']){
  const value=receipt();value.failures[0].error=message;assert.throws(()=>assertEntrantRaceFailure(value,'next','run-one',campaign),/host or resource/,message);
 }
});
