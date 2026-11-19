const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { DOMParser } = require('linkedom');
const title = 'A precise article about low power analog circuits';
function setup(fields = {}, extra = '') {
  const Zotero = {
    Prefs: { get() {} }, CreatorTypes: { getID: () => 1 }, Libraries: { get: () => ({ editable: true }) },
    logError() {}, alert() {},
    ProgressWindow: function () { this.ItemProgress = function () { this.setText = this.setProgress = () => {}; }; this.show = this.changeHeadline = this.startCloseTimer = () => {}; }
  };
  const context = vm.createContext({ Zotero, URL, APP_SHUTDOWN: 2 });
  for (const file of ['bootstrap.js', 'affiliations.js', 'source-pages.js']) vm.runInContext(fs.readFileSync(file, 'utf8'), context);
  const api = context.CorrespondingAuthorPro;
  api.affiliations = context.AffiliationSupport; api.affiliations.api = api;
  api.sources = context.SourcePageSupport; api.sources.api = api;
  api.request = async () => { throw Error('No real network in unit tests'); };
  const paper = {
    libraryID: 1, extra, saves: 0, fields: { title, date: '2024', ...fields }, tags: new Set(),
    getField(key) { return key === 'extra' ? this.extra : this.fields[key] || ''; },
    setField(key, value) { this.extra = value; }, getAttachments: () => [],
    getCreators: () => [{ firstName: 'Alice', lastName: 'Li', creatorTypeID: 1 }], isRegularItem: () => true,
    hasTag(t) { return this.tags.has(t); }, addTag(t) { this.tags.add(t); }, removeTag(t) { this.tags.delete(t); },
    async saveTx() { this.saves++; }
  };
  const win = { DOMParser, ZoteroPane: { getSelectedItems: () => [paper] } };
  return { api, support: api.sources, paper, win, Zotero };
}
function page(doi = '', extra = '') {
  return `<html><head><meta name="citation_title" content="${title}">${doi ? `<meta name="citation_doi" content="${doi}">` : ''}</head><body><ul><li><a class="author-name">Alice Li</a><p id="authCorresponding-1">Corresponding author</p><p id="authAffiliations-1">University A</p></li></ul>${extra}</body></html>`;
}
test('existing article URL works without DOI and fills both missing fields', async () => {
  const { support, paper, win, api } = setup({ url: 'https://publisher.example/article/42' });
  support.requestPage = async url => ({ html: page(), url });
  await support.fillItems([paper], win);
  assert.equal(api.parseExtra(paper.extra), 'Alice Li');
  assert.equal(api.affiliations.read(paper).records[0].author, 'Alice Li');
  assert.match(paper.extra, /University A/);
  assert.equal(support.readTrace(paper).pages[0].url, 'https://publisher.example/article/42');
});
test('title discovery requires exact title and matching author or year', () => {
  const { support, paper } = setup();
  const good = { DOI: '10.1000/right', title: [title], author: [{ family: 'Li' }] };
  assert.equal(support.matchingWork([good], paper).DOI, '10.1000/right');
  assert.equal(support.matchingWork([{ ...good, title: ['A different paper'] }], paper), null);
  assert.equal(support.matchingWork([good, { ...good, DOI: '10.1000/duplicate' }], paper), null);
  assert.equal(support.matchingWork([{ ...good, author: [{ family: 'Wrong' }] }], paper), null);
});
test('missing URL and DOI trigger title search then publisher landing page', async () => {
  const { support, paper, win, api } = setup();
  api.request = async url => {
    assert.match(url, /query.title=/);
    return JSON.stringify({ message: { items: [{ DOI: '10.1000/found', title: [title], author: [{ family: 'Li' }], resource: { primary: { URL: 'https://publisher.example/found' } } }] } });
  };
  support.requestPage = async url => ({ url, html: page('10.1000/found') });
  const result = await support.lookup(paper, win);
  assert.equal(result.corresponding.join(), 'Alice Li');
  assert.equal(result.institutionsURL, 'https://publisher.example/found');
  assert.match(result.trace.discovery, /已核对/);
});
test('conflicting DOI on a webpage is rejected even when title matches', () => {
  const { support, paper, win } = setup({ DOI: '10.1000/right' });
  const result = support.parsePage(page('10.1000/wrong'), paper, win, '10.1000/right');
  assert.equal(result.identity, '');
  assert.equal(result.corresponding.length + result.records.length, 0);
});
test('article author-information links are followed within the same publisher', async () => {
  const { support, paper, win } = setup({ url: 'https://publisher.example/article' });
  const urls = [];
  support.requestPage = async url => {
    urls.push(url);
    const html = url.endsWith('/authors-info') ? page() : `<html><head><meta name="citation_title" content="${title}"></head><body><a href="/authors-info">Author information</a><a href="https://elsewhere.example/aff">Affiliations</a></body></html>`;
    return { url, html };
  };
  const result = await support.lookup(paper, win);
  assert.deepEqual(urls, ['https://publisher.example/article', 'https://publisher.example/authors-info']);
  assert.equal(result.corresponding.join(), 'Alice Li');
});
test('real PLOS webpage yields the explicitly marked corresponding author and mapped institutions', () => {
  const { support, paper, win } = setup({ DOI: '10.1371/journal.pone.0300001' });
  const html = fs.readFileSync('tests/fixtures/plos-source.html', 'utf8');
  const result = support.parsePage(html, paper, win, paper.fields.DOI);
  assert.equal(result.corresponding.join(';'), 'Kris Aubrey-Bassler');
  assert(result.records.some(r => r.author === 'Kris Aubrey-Bassler' && r.institutions.some(n => n.includes('Memorial University'))));
  assert(result.records.some(r => r.author === 'Oluwatosin Badejo'));
});
test('missing correspondence automatically uses source URL after local and metadata paths fail', async () => {
  const { support, paper, win, api } = setup({ url: 'https://publisher.example/paper' });
  api.fromPDF = async () => [];
  support.requestPage = async url => ({ url, html: page() });
  await api.identifySelected(win, false);
  assert.equal(api.parseExtra(paper.extra), 'Alice Li');
  assert.match(api.readField(paper.extra, api.sourcePattern), /publisher.example/);
});
test('missing institutions automatically use source URL even when DOI is absent', async () => {
  const { support, paper, win, api } = setup({ url: 'https://publisher.example/paper' });
  support.requestPage = async url => ({ url, html: page() });
  const result = await api.affiliations.fetch(paper, win);
  assert(result.data.records.some(r => r.institutions.includes('University A')));
  assert.match(result.data.source, /publisher.example/);
});
test('source-page completion preserves confirmed correspondence and manual institutions', async () => {
  const { support, paper, win, api } = setup({ url: 'https://publisher.example/paper' }, '通讯作者: Manual Name\n通讯作者来源: 手工确认');
  await api.affiliations.write(paper, { manual: true, source: '手工确认', records: [{ author: 'Manual Name', institutions: ['Manual University'] }] });
  support.requestPage = async () => { throw Error('must not fetch'); };
  const saves = paper.saves;
  await support.fillItems([paper], win);
  assert.equal(paper.saves, saves);
  assert.equal(api.parseExtra(paper.extra), 'Manual Name');
});
test('blocked source pages are recorded and failure is not cached across retries', async () => {
  const { support, paper, win } = setup({ url: 'https://publisher.example/paper' });
  let attempts = 0;
  support.requestPage = async () => { attempts++; throw { status: 403 }; };
  const first = await support.lookup(paper, win);
  const second = await support.lookup(paper, win);
  assert.equal(attempts, 2);
  assert.equal(first.corresponding.length, 0);
  assert.match(second.trace.pages[0].status, /403/);
});
test('saved webpage attachments are considered while file and script URLs are ignored', async () => {
  const { support, paper, Zotero } = setup({ url: 'javascript:alert(1)' });
  paper.getAttachments = () => [1, 2];
  Zotero.Items = { getAsync: async id => ({ getField: () => id === 1 ? 'https://publisher.example/snapshot-source' : 'file:///private.txt' }) };
  assert.equal((await support.candidates(paper)).join(), 'https://publisher.example/snapshot-source');
});
test('IEEE empty 202 response is reported as an empty page rather than an identity mismatch', async () => {
  const { support, Zotero } = setup();
  Zotero.HTTP = { request: async () => ({ status: 202, responseText: '' }) };
  await assert.rejects(support.requestPage('https://ieeexplore.ieee.org/document/1'), e => e.kind === 'empty' && e.status === 202);
});
test('Elsevier-style HTML refresh is followed before paper identity checks', async () => {
  const { support, paper, win } = setup({ url: 'https://linkinghub.example/paper' });
  support.requestPage = async url => ({ url, html: url.includes('/paper') ? '<html><head><meta http-equiv="REFRESH" content="2; url=https://publisher.example/actual"></head><body>Redirecting</body></html>' : page() });
  const result = await support.lookup(paper, win);
  assert.equal(result.institutionsURL, 'https://publisher.example/actual');
  assert.match(result.trace.pages[0].status, /跳转/);
});
test('saved local publication fills institutions without repeating blocked network calls', async () => {
  const { support, paper, win, api } = setup({ url: 'https://ieeexplore.ieee.org/document/1' }, '通讯作者: Alice Li\n通讯作者来源: 手工确认');
  api.affiliations.fromLocalPDF = async () => [{ author: 'Alice Li', institutions: ['Alpha University'], verified: true }];
  support.requestPage = async () => { throw Error('must not request'); };
  support.paperIndex = async () => { throw Error('must not request index'); };
  await support.fillItems([paper], win);
  assert.equal(api.affiliations.read(paper).records[0].institutions.join(), 'Alpha University');
  assert.match(api.affiliations.read(paper).source, /本地论文/);
});
test('paper-level index rejects a mismatched DOI and does not read current author profiles', async () => {
  const { support, paper, api } = setup({ DOI: '10.1000/right' });
  api.request = async () => JSON.stringify({ doi: 'https://doi.org/10.1000/wrong', authorships: [{ author: { display_name: 'Alice Li' }, institutions: [{ display_name: 'Wrong University' }] }] });
  assert.equal(await support.paperIndex(paper), null);
  api.request = async url => {
    assert.match(url, /\/works\/https:\/\/doi.org\//);
    return JSON.stringify({ doi: 'https://doi.org/10.1000/right', authorships: [{ author: { display_name: 'Alice Li' }, institutions: [{ display_name: 'Paper University' }] }] });
  };
  assert.equal((await support.paperIndex(paper)).records[0].institutions.join(), 'Paper University');
});
test('browser verification page is reported explicitly', async () => {
  const { support, Zotero } = setup();
  Zotero.HTTP = { request: async () => ({ status: 200, responseText: '<html><h1>JavaScript is disabled</h1>We need to verify that you are not a robot.</html>' }) };
  await assert.rejects(support.requestPage('https://publisher.example/1'), e => e.kind === 'verification');
});
