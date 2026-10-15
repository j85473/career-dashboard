import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { adpPostingDetailUrl, parseAdpPosting } from '../../src/lib/adpPosting';
import { jsonLdLocationString, jsonLdPageMetadata } from '../../src/lib/atsApi';
import { locationTriageVerdict } from '../../src/lib/localTriage';
import { parsePostingReaderMetadata } from '../../src/lib/postingMetadata';
import { providerPostingLocation, INCOMPLETE_LOCATION } from '../../src/lib/postingLocation';
import { readManualImportPage } from '../../src/lib/manualImportPage';
import { isGenericManualImportTitle } from '../../src/lib/manualImportPolicy';
const adp='https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=87b90c88-c86a-4cbe-bbee-3a1ea9a703ec&jobId=396254&jobId=588107';
const fixture=JSON.parse(readFileSync(new URL('../fixtures/adp/channel-sales-manager.json',import.meta.url),'utf8'));

test('ADP reads the selected opening identity and complete provider location list',()=>{
 const result=parseAdpPosting(fixture,adp)!;
 assert.equal(result.title,'Channel Sales Manager I');
 assert.equal(result.company,'Lantronix');
 assert.equal(result.location,'Plymouth, MN, US; DC, US');
 assert.equal(locationTriageVerdict(result.location).pass,true);
 assert.match(adpPostingDetailUrl(adp)!,/job-requisitions\/588107\?/);
 assert.equal(parseAdpPosting(fixture,adp.replace('588107','999999')),null);
 assert.equal(adpPostingDetailUrl(adp.replace('workforcenow.adp.com','evil.example')),null);
});
test('portal titles cannot masquerade as authored job titles',async()=>{
 assert.equal(isGenericManualImportTitle('Recruitment'),true);
 assert.equal(isGenericManualImportTitle('Career Center | Recruitment'),true);
 assert.equal(isGenericManualImportTitle('Recruitment Manager'),false);
 const result=await readManualImportPage({html:'<title>Recruitment</title><body>Loading...</body>',url:adp},async()=>assert.fail('Do not infer a role from a portal title'));
 assert.equal(result.title,'Manual Job Import');
});
test('scheduled Lever and Ashby locations retain local options after foreign primary sites',()=>{
 const ashby=providerPostingLocation({location:'Canada',secondaryLocations:[{location:'United States'},{location:'Plymouth, MN'}]});
 const lever=providerPostingLocation({categories:{location:'Washington, DC',allLocations:['Washington, DC','Plymouth, MN']}});
 assert.equal(ashby,'Canada; United States; Plymouth, MN');
 assert.equal(lever,'Washington, DC; Plymouth, MN');
 assert.equal(locationTriageVerdict(ashby).pass,true);
 assert.equal(locationTriageVerdict(lever).pass,true);
 assert.equal(jsonLdLocationString([{address:{addressLocality:'Washington',addressRegion:'DC'}},{address:{addressLocality:'Plymouth',addressRegion:'MN'}}]),'Washington, DC; Plymouth, MN');
});
test('reader accumulates location labels and flags positive hidden-location counts',()=>{
 const url='https://example.com/jobs/1';
 const read=(text:string)=>parsePostingReaderMetadata(`URL Source: ${url}\nMarkdown Content:\n${text}`,url);
 assert.equal(read('Location: Washington, DC\nLocation: Plymouth, MN').location,'Washington, DC; Plymouth, MN');
 assert.equal(read('Locations:\nWashington, DC\nPlymouth, MN\n## Responsibilities\nWork with people.').location,'Washington, DC; Plymouth, MN');
 assert.equal(read('DC, US\n+1 More Locations\n## Job Description').location,INCOMPLETE_LOCATION);
 assert.equal(locationTriageVerdict(`Washington, DC; ${INCOMPLETE_LOCATION}`).pass,true);
 assert.equal(read('Location: London\n+0 more locations\n## Job Description').location,'London');
 assert.equal(read('Location: London\nWe plan to open 100 additional locations across Europe.').location,'London');
});
test('US remote spelling variations are equivalent without accepting state restrictions',()=>{
 for (const text of ['USA - 100% Remote','United States - Remote (Remote)','US - Remote (Any Location)','United States of America : Remote','Remote Position (USA)','Remote - USA - Nationwide','USA Remote & Travel','USA-Remote (Any)','Fully Remote - Based in USA','Remote job']) {
  assert.equal(locationTriageVerdict(text).pass,true,text);
 }
 for(const text of ['USA - CA (Remote)','Remote - New York','Remote - Canada','US Remote - Texas','London (Remote)']) assert.equal(locationTriageVerdict(text).pass,false,text);
});
test('comma-separated city/state lists retain a local option without confusing address components',()=>{
 assert.equal(locationTriageVerdict('Washington, DC, Plymouth, MN').pass,true);
 assert.equal(locationTriageVerdict('Boston, Massachusetts, Minneapolis, Minnesota').pass,true);
 assert.equal(locationTriageVerdict('Washington, DC, Austin, TX').pass,false);
 assert.equal(locationTriageVerdict('2355 Highway 36 W, Ste 202, Roseville, MN 55113').pass,true);
});

test('structured page metadata distinguishes a complete multi-site list from a hidden remainder',()=>{
 const primary={address:{addressLocality:'Washington',addressRegion:'DC'}};
 const local={address:{addressLocality:'Plymouth',addressRegion:'MN'}};
 assert.equal(jsonLdPageMetadata({jobLocation:[primary]},'<div>+1 More Locations</div>').location,`Washington, DC; ${INCOMPLETE_LOCATION}`);
 assert.equal(jsonLdPageMetadata({jobLocation:[primary,local]},'<div>+1 More Locations</div>').location,'Washington, DC; Plymouth, MN');
});

test('a country-only secondary site survives structured metadata recovery',()=>{
 assert.equal(jsonLdPageMetadata({jobLocation:[{address:{addressLocality:'Toronto',addressCountry:'Canada'}},{address:{addressCountry:'United States'}}]},'<div>+1 More Locations</div>').location?.startsWith('Toronto, Canada; United States'),true);
});
