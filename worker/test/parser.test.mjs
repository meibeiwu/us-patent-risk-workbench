import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGoogleJson, parseOpsXml } from '../src/index.js';

const xml = `<?xml version="1.0"?><ops:world-patent-data xmlns:ops="http://ops.epo.org"><ops:biblio-search total-result-count="2"><ops:search-result><ops:exchange-documents><ops:exchange-document><bibliographic-data><publication-reference><document-id document-id-type="docdb"><country>US</country><doc-number>8596173</doc-number><kind>B2</kind><date>20131203</date></document-id></publication-reference><invention-title lang="fr">Outil d'épluchage</invention-title><invention-title lang="en">Peeling tool</invention-title><parties><applicants><applicant><applicant-name><name>Conair LLC</name></applicant-name></applicant></applicants></parties></bibliographic-data></ops:exchange-document><ops:exchange-document><bibliographic-data><publication-reference><document-id document-id-type="docdb"><country>US</country><doc-number>D918676</doc-number><kind>S1</kind><date>20210511</date></document-id></publication-reference><invention-title lang="en">Vegetable peeler</invention-title></bibliographic-data></ops:exchange-document></ops:exchange-documents></ops:search-result></ops:biblio-search></ops:world-patent-data>`;

test('parses utility results and excludes US design documents', () => {
  const parsed = parseOpsXml(xml, 'utility');
  assert.equal(parsed.total, 2);
  assert.equal(parsed.results.length, 1);
  assert.equal(parsed.results[0].publication, 'US8596173B2');
  assert.equal(parsed.results[0].title, 'Peeling tool');
});

test('parses US design result separately', () => {
  const parsed = parseOpsXml(xml, 'design');
  assert.equal(parsed.results.length, 1);
  assert.equal(parsed.results[0].publication, 'USD918676S1');
  assert.equal(parsed.results[0].type, 'design');
});

const googlePayload = { results: { total_num_results: 2, cluster: [{ result: [
  { patent: { title: ' Combination &amp; double peeler', snippet: 'A hollow handle &hellip;', priority_date: '2013-09-13', publication_date: '2015-03-19', assignee: 'IdeaVillage Products Corp.', publication_number: 'US20150079258A1', thumbnail: 'aa/sample.png', family_metadata: { aggregated: { country_status: [{ country_code: 'US', best_patent_stage: { state: 'NOT_ACTIVE' } }] } } } },
  { patent: { title: ' Vegetable peeler', publication_number: 'USD918676S1', figures: [{ thumbnail: 'bb/design.png' }], family_metadata: { aggregated: { country_status: [{ country_code: 'US', best_patent_stage: { state: 'ACTIVE' } }] } } } }
] }] } };

test('parses Google utility results with normalized metadata', () => {
  const parsed = parseGoogleJson(googlePayload, 'utility');
  assert.equal(parsed.results.length, 1);
  assert.equal(parsed.results[0].publication, 'US20150079258A1');
  assert.equal(parsed.results[0].title, 'Combination & double peeler');
  assert.equal(parsed.results[0].legalStatus, 'not_active');
  assert.match(parsed.results[0].thumbnail, /^https:\/\/patentimages\.storage\.googleapis\.com\//);
});

test('parses Google design results separately', () => {
  const parsed = parseGoogleJson(googlePayload, 'design');
  assert.equal(parsed.results.length, 1);
  assert.equal(parsed.results[0].publication, 'USD918676S1');
  assert.equal(parsed.results[0].type, 'design');
  assert.equal(parsed.results[0].legalStatus, 'active');
});
