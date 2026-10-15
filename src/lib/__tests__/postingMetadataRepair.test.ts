import assert from 'node:assert/strict';
import test from 'node:test';
import { planPostingMetadataRepair, canonicalRepairedLocation } from '../postingMetadataRepair';
const job={title:'Partner Manager',company:'Employer',location:'USA - 100% Remote',url:'https://example.com/jobs/1',source:'ATS-ashby',status:'archived',scoringStatus:'skipped',passReason:'Locally triaged out: Location outside the searched geographies (USA - 100% Remote)',tailoringStaged:false};
const evidence={location:job.location,identityVerified:true,completeLocations:true,source:'stored authored location'};
test('repair restores only a geography rejection with complete verified evidence',()=>{
 const p=planPostingMetadataRepair(job,evidence,{hasScores:false,hasHumanDecision:false})!;
 assert.equal(p.action,'restore_for_review');assert.equal(p.metadata.location,'Remote - United States');assert.equal(p.lifecycle?.status,'pending_af');
 for(const guard of [{hasScores:true,hasHumanDecision:false},{hasScores:false,hasHumanDecision:true}]) assert.equal(planPostingMetadataRepair(job,evidence,guard)?.action,'metadata_only');
 assert.equal(planPostingMetadataRepair(job,{...evidence,identityVerified:false},{hasScores:false,hasHumanDecision:false}),null);
 assert.equal(planPostingMetadataRepair({...job,passReason:'Already applied'},evidence,{hasScores:false,hasHumanDecision:false})?.action,'metadata_only');
 assert.equal(planPostingMetadataRepair(job,{...evidence,completeLocations:false},{hasScores:false,hasHumanDecision:false})?.action,'metadata_only');
});
test('a reviewed manual restoration preserves scoring state, staging, and all score fields',()=>{
 const p=planPostingMetadataRepair({...job,source:'Manual Import',title:'Recruitment',company:'workforcenow.adp.com',status:'passed',tailoringStaged:true,scoringStatus:'scored',passReason:'Location mismatch'},
 {...evidence,title:'Channel Sales Manager I',company:'Lantronix',location:'Plymouth, MN; DC, US'}, {hasScores:true,hasHumanDecision:true,reviewedRestore:true})!;
 assert.equal(p.metadata.title,'Channel Sales Manager I');assert.equal(p.action,'restore_for_review');assert.equal(p.lifecycle?.status,'inbox');assert.equal(p.lifecycle?.scoringStatus,'scored');
 assert.doesNotMatch(JSON.stringify(p),/fitScore|aimFitScore|reqFitScore|tailoringStaged/);
});
test('repair never replaces a known role with another source role or turns a state restriction into nationwide remote',()=>{
 assert.equal(planPostingMetadataRepair(job,{...evidence,title:'Other role'},{hasScores:false,hasHumanDecision:false}),null);
 assert.equal(canonicalRepairedLocation('USA - CA (Remote)'),'USA - CA (Remote)');
});
