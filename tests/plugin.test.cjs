const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { DOMParser } = require('linkedom');
function setup() {
  const prefs = new Map(), alerts = [];
  const Zotero = {
    Prefs: { get: k => prefs.get(k), set: (k, v) => prefs.set(k, v) },
    CreatorTypes: { getID: () => 1 }, Libraries: { get: () => ({ editable: true }) },
    logError() {}, alert: (w, t, m) => alerts.push(m),
    ProgressWindow: function () { this.ItemProgress = function () { this.setText = this.setProgress = () => {}; }; this.show = this.changeHeadline = this.startCloseTimer = () => {}; }
  };
  const context = vm.createContext({ Zotero, Services: {}, APP_SHUTDOWN: 2 });
  vm.runInContext(fs.readFileSync('bootstrap.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('affiliations.js', 'utf8'), context);
  const api = context.CorrespondingAuthorPro;
  api.affiliations = context.AffiliationSupport;
  api.affiliations.api = api;
  const win = { DOMParser, ZoteroPane: { getSelectedItems: () => [] } };
  return { api, Zotero, prefs, win, alerts };
}
function item(extra = '', creators = []) {
  return { extra, creators, libraryID: 1, tags: new Set(), saves: 0,
    getField(k) { return k === 'extra' ? this.extra : ''; },
    setField(k, v) { this.extra = v; }, getCreators() { return this.creators; },
    isRegularItem: () => true, getAttachments: () => [], hasTag(t) { return this.tags.has(t); },
    addTag(t) { this.tags.add(t); }, removeTag(t) { this.tags.delete(t); },
    async saveTx() { this.saves++; }
  };
}
const authors = [{ firstName: 'Alice', lastName: 'Li', creatorTypeID: 1 }, { firstName: 'Bob', lastName: 'Smith', creatorTypeID: 1 }];
test('parses old CA labels, multiline multiple authors and keeps unrelated Extra', () => {
  const { api } = setup();
  assert.equal(api.parseExtra('DOI: 10.1/foo\nCorresponding Authors： Alice Li; Bob Smith\nCA: 张三'), 'Alice Li; Bob Smith; 张三');
  const updated = api.replaceField('DOI: x\nCorrespondence: Alice Li\n通信作者: 张三', api.caPattern, '通讯作者', 'Bob Smith');
  assert.equal(updated, '通讯作者: Bob Smith\nDOI: x');
});
test('many authors and aliases map to one group, collaborations map to several', () => {
  const { api } = setup();
  const rules = [{ group: 'A', authors: ['Alice Li', 'A. Li'] }, { group: 'B', authors: ['Bob Smith'] }];
  assert.equal(api.matchGroups('ALICE LI; A.Li; Bob Smith', rules).join(','), 'A,B');
  assert.equal(api.matchGroups('Li', rules).length, 0);
  assert.throws(() => api.validateRules([{ group: 'A', authors: ['A. Li'] }, { group: 'B', authors: ['a li'] }]), /两个课题组/);
});
test('rules are library scoped, corrupt rules never silently disappear', () => {
  const { api, prefs } = setup();
  api.saveRules(1, [{ group: 'A', authors: ['Alice Li'] }]);
  api.saveRules(2, [{ group: 'B', authors: ['Alice Li'] }]);
  assert.equal(api.loadRules(1)[0].group, 'A');
  assert.equal(api.loadRules(2)[0].group, 'B');
  prefs.set(api.prefKey, '{bad');
  assert.throws(() => api.loadRules(1));
});
test('reclassification updates owned tags, keeps unrelated tags and is idempotent', async () => {
  const { api } = setup(), paper = item('DOI: x\n通讯作者: Alice Li');
  paper.tags.add('阅读中');
  await api.classifyItem(paper, [{ group: 'A', authors: ['Alice Li'] }]);
  assert(paper.tags.has('课题组/A'));
  const saves = paper.saves;
  await api.classifyItem(paper, [{ group: 'A', authors: ['Alice Li'] }]);
  assert.equal(paper.saves, saves);
  await api.classifyItem(paper, [{ group: 'B', authors: ['Alice Li'] }]);
  assert(!paper.tags.has('课题组/A')); assert(paper.tags.has('课题组/B')); assert(paper.tags.has('阅读中'));
  await api.classifyItem(paper, []);
  assert(!paper.tags.has('课题组/B')); assert.match(paper.extra, /DOI: x/);
});
test('matching pre-existing user tag is never claimed or deleted', async () => {
  const { api } = setup(), paper = item('通讯作者: Alice Li');
  paper.tags.add('课题组/A');
  await api.classifyItem(paper, [{ group: 'A', authors: ['Alice Li'] }]);
  await api.classifyItem(paper, []);
  assert(paper.tags.has('课题组/A'));
});
test('text identification requires explicit marker, full names and word boundaries', () => {
  const { api } = setup();
  assert.equal(api.fromMarkedText('Alice Li and Bob Smith wrote this paper.', authors).length, 0);
  assert.equal(api.fromMarkedText('Corresponding author: Li', authors).length, 0);
  assert.equal(api.fromMarkedText('Corresponding author: Alice Lim', authors).length, 0);
  assert.equal(api.fromMarkedText('Corresponding authors: Alice Li and Bob Smith', authors).join(';'), 'Alice Li;Bob Smith');
  assert.equal(api.fromMarkedText('(Corresponding author: Bob Smith.)', authors).join(), 'Bob Smith');
  assert.equal(api.fromMarkedText('Corresponding author:\nBob Smith', authors).join(), 'Bob Smith');
  assert.equal(api.fromMarkedText('通讯作者：张三', [{ firstName: '三', lastName: '张' }]).join(), '张三');
});
test('JATS handles explicit flags and cross references, excluding ordinary authors and references', () => {
  const { api, win } = setup();
  const xml = '<article><front><article-meta><contrib-group>' +
    '<contrib contrib-type="author"><name><surname>Li</surname><given-names>Alice</given-names></name></contrib>' +
    '<contrib contrib-type="author" corresp="yes"><name><surname>Smith</surname><given-names>Bob</given-names></name></contrib>' +
    '<contrib contrib-type="author"><name><surname>张</surname><given-names>三</given-names></name><xref ref-type="corresp" rid="c1"/></contrib>' +
    '</contrib-group></article-meta></front></article>';
  assert.equal(api.fromJATS(xml, win).join(';'), 'Bob Smith;张三');
});
test('publisher HTML uses correspondence block and excludes scripts and references', () => {
  const { api, win } = setup();
  const html = '<html><body><script>Corresponding author: Alice Li</script><div class="corresponding-author">Bob Smith</div><div id="references">Corresponding author: Alice Li</div></body></html>';
  assert.equal(api.fromHTML(html, authors, win).join(';'), 'Bob Smith');
});
test('default identification never overwrites legacy or manually confirmed values', async () => {
  const { api, win } = setup(), paper = item('通讯作者: Alice Li', authors);
  win.ZoteroPane.getSelectedItems = () => [paper];
  api.fromPDF = async () => { throw Error('must not read'); };
  await api.identifySelected(win, false);
  assert.equal(paper.saves, 0);
  paper.extra += '\n通讯作者来源: 手工确认';
  await api.identifySelected(win, false, true);
  assert.equal(paper.saves, 0);
});
test('refresh replaces legacy result only when evidence exists; unknown stays unchanged', async () => {
  const { api, win } = setup(), paper = item('通讯作者: Alice Li\nDOI: x', authors);
  win.ZoteroPane.getSelectedItems = () => [paper];
  api.fromPDF = async () => [];
  await api.identifySelected(win, false, true);
  assert.equal(paper.saves, 0);
  api.fromPDF = async () => ['Bob Smith'];
  await api.identifySelected(win, false, true);
  assert.equal(api.parseExtra(paper.extra), 'Bob Smith');
  assert.match(paper.extra, /DOI: x/);
});
test('normal lookup never silently estimates; explicit estimate excludes editors', async () => {
  const { api, win } = setup(), paper = item('', [...authors, { firstName: 'Editor', lastName: 'Wrong', creatorTypeID: 2 }]);
  win.ZoteroPane.getSelectedItems = () => [paper];
  api.fromPDF = async () => [];
  await api.identifySelected(win, false);
  assert.equal(paper.saves, 0);
  await api.identifySelected(win, true);
  assert.equal(api.parseExtra(paper.extra), 'Bob Smith');
  assert.match(paper.extra, /估计/);
});
test('identification immediately applies saved group rules', async () => {
  const { api, win } = setup(), paper = item('', authors);
  api.saveRules(1, [{ group: 'Smith Lab', authors: ['Bob Smith'] }]);
  win.ZoteroPane.getSelectedItems = () => [paper];
  api.fromPDF = async () => ['Bob Smith'];
  await api.identifySelected(win, false);
  assert(paper.tags.has('课题组/Smith Lab'));
});
test('Europe PMC checks DOI identity and requests the matching full text', async () => {
  const { api, win } = setup(), urls = [];
  api.request = async url => {
    urls.push(url);
    if (url.includes('/search?')) return JSON.stringify({ resultList: { result: [
      { doi: '10.1000/wrong', pmcid: 'PMC1' }, { doi: '10.1000/right', pmcid: 'PMC2' }
    ] } });
    return '<article><article-meta><contrib contrib-type="author" corresp="yes"><name><surname>Li</surname><given-names>Alice</given-names></name></contrib></article-meta></article>';
  };
  assert.equal((await api.fromEuropePMC('10.1000/right', win)).join(), 'Alice Li');
  assert.match(urls[1], /PMC2\/fullTextXML$/);
});
test('network failures are reported per article and never erase an existing estimate', async () => {
  const { api, win, alerts } = setup();
  const paper = item('通讯作者: Bob Smith\n通讯作者来源: 估计（末位作者，未经确认）', authors);
  const getField = paper.getField.bind(paper);
  paper.getField = key => key === 'DOI' ? '10.1000/test' : getField(key);
  win.ZoteroPane.getSelectedItems = () => [paper];
  api.fromPDF = async () => [];
  api.request = async () => { throw new Error('HTTP 502'); };
  await api.identifySelected(win, false);
  assert.equal(api.parseExtra(paper.extra), 'Bob Smith');
  assert.equal(paper.saves, 0);
  assert.match(alerts[0], /网络请求未成功 2 次/);
});
test('bulk assignment uses a saved group without requiring authors or modifying author rules', async () => {
  const { api, win, prefs } = setup();
  api.saveRules(1, [{ group: '已建组', authors: [] }]);
  const originalRules = prefs.get(api.prefKey);
  const first = item('DOI: x'), second = item('通讯作者: Alice Li'), untouched = item('DOI: other');
  win.ZoteroPane.getSelectedItems = () => [first, second];
  await api.assignToExistingGroup(win, '已建组');
  for (const paper of [first, second]) {
    assert.equal(api.readField(paper.extra, api.groupPattern), '已建组');
    assert.equal(api.readField(paper.extra, api.manualGroupPattern), '已建组');
    assert(paper.tags.has('课题组/已建组'));
  }
  assert.equal(api.parseExtra(second.extra), 'Alice Li');
  assert.match(first.extra, /DOI: x/);
  assert.equal(untouched.saves, 0);
  assert.equal(prefs.get(api.prefKey), originalRules);
});
test('manual selection overrides author rules and survives subsequent automatic classification', async () => {
  const { api, win } = setup(), paper = item('通讯作者: Alice Li');
  api.saveRules(1, [{ group: '自动组', authors: ['Alice Li'] }, { group: '手动组', authors: [] }]);
  await api.classifyItem(paper, api.loadRules(1));
  win.ZoteroPane.getSelectedItems = () => [paper];
  await api.assignToExistingGroup(win, '手动组');
  await api.classifyItem(paper, api.loadRules(1));
  assert(paper.tags.has('课题组/手动组'));
  assert(!paper.tags.has('课题组/自动组'));
  await api.clearManualGroups(win);
  assert.equal(api.readField(paper.extra, api.manualGroupPattern), '');
  assert(paper.tags.has('课题组/自动组'));
  assert(!paper.tags.has('课题组/手动组'));
});
test('assigning an already effective group still saves the manual override', async () => {
  const { api, win } = setup(), paper = item('通讯作者: Alice Li');
  api.saveRules(1, [{ group: 'A', authors: ['Alice Li'] }]);
  await api.classifyItem(paper, api.loadRules(1));
  const previousSaves = paper.saves;
  win.ZoteroPane.getSelectedItems = () => [paper];
  await api.assignToExistingGroup(win, 'A');
  assert.equal(paper.saves, previousSaves + 1);
  await api.classifyItem(paper, []);
  assert(paper.tags.has('课题组/A'));
});
test('switching manual group removes old generated tag and preserves other metadata', async () => {
  const { api, win } = setup(), paper = item('DOI: x');
  paper.tags.add('待阅读');
  api.saveRules(1, [{ group: 'A', authors: [] }, { group: 'B', authors: [] }]);
  win.ZoteroPane.getSelectedItems = () => [paper];
  await api.assignToExistingGroup(win, 'A');
  await api.assignToExistingGroup(win, 'B');
  assert(!paper.tags.has('课题组/A'));
  assert(paper.tags.has('课题组/B'));
  assert(paper.tags.has('待阅读'));
  assert.match(paper.extra, /DOI: x/);
  assert.equal(api.readField(paper.extra, api.groupPattern), 'B');
});
test('deleted groups and read-only items are rejected before any bulk write', async () => {
  const { api, win, Zotero } = setup(), first = item(''), second = item('');
  win.ZoteroPane.getSelectedItems = () => [first, second];
  await assert.rejects(api.assignToExistingGroup(win, '已删组'), /删除或更名/);
  api.saveRules(1, [{ group: 'A', authors: [] }]);
  Zotero.Libraries.get = () => ({ editable: false });
  await assert.rejects(api.assignToExistingGroup(win, 'A', [first, second]), /不可写入/);
  assert.equal(first.saves + second.saves, 0);
  assert.equal(first.extra + second.extra, '');
});
test('saved groups populate a fresh selection menu including groups without authors', () => {
  const { api, win } = setup();
  const doc = new DOMParser().parseFromString('<html><body></body></html>', 'text/html');
  doc.createXULElement = name => doc.createElement(name);
  win.document = doc;
  win.ZoteroPane.getSelectedItems = () => [item(''), item('')];
  const popup = doc.createXULElement('menupopup');
  api.saveRules(1, [{ group: 'A', authors: [] }, { group: 'B', authors: ['Alice Li'] }]);
  api.populateGroupMenu(win, popup);
  assert.deepEqual([...popup.children].map(n => n.getAttribute('label')), ['A', 'B']);
  api.saveRules(1, [{ group: '新名称', authors: [] }]);
  api.populateGroupMenu(win, popup);
  assert.deepEqual([...popup.children].map(n => n.getAttribute('label')), ['新名称']);
  api.saveRules(1, []);
  api.populateGroupMenu(win, popup);
  assert.equal(popup.firstChild.getAttribute('disabled'), 'true');
});
test('Crossref affiliations are tied to authors and DOI identity is checked', () => {
  const { api } = setup(), support = api.affiliations;
  const sample = { message: { DOI: '10.1000/test', author: [
    { given: 'Alice', family: 'Li', affiliation: [{ name: 'University A' }, { name: 'Institute B' }] },
    { given: 'Bob', family: 'Smith', affiliation: [{ name: 'University C' }] },
    { family: 'NoData' }
  ] } };
  const records = support.fromCrossref(sample, '10.1000/test');
  assert.equal(records[0].author, 'Alice Li');
  assert.equal(records[0].institutions.join(';'), 'University A;Institute B');
  assert.equal(records[1].institutions.join(), 'University C');
  assert.equal(support.fromCrossref(sample, '10.1000/other').length, 0);
});
test('live Crossref fixture yields author institutions', () => {
  const { api } = setup();
  const fixture = JSON.parse(fs.readFileSync('tests/fixtures/crossref-live.json', 'utf8'));
  const records = api.affiliations.fromCrossref(fixture, fixture.message.DOI);
  assert(records.length > 0);
  assert(records.every(r => r.author && r.institutions.length));
});
test('JATS follows author affiliation references and retains unlinked institutions separately', () => {
  const { api, win } = setup();
  const xml = '<article><article-meta><contrib-group>' +
    '<contrib contrib-type="author"><name><given-names>Alice</given-names><surname>Li</surname></name><xref ref-type="aff" rid="a1 a2"/></contrib>' +
    '<contrib contrib-type="author"><name><given-names>Bob</given-names><surname>Smith</surname></name><xref ref-type="aff" rid="a2"/></contrib></contrib-group>' +
    '<aff id="a1"><label>1</label><institution>University A</institution></aff>' +
    '<aff id="a2"><label>2</label><institution>Institute B</institution></aff>' +
    '<aff id="a3"><institution>Unlinked University</institution></aff></article-meta><back><aff><institution>Reference University</institution></aff></back></article>';
  const records = api.affiliations.fromJATS(xml, win);
  assert.equal(records[0].author, 'Alice Li');
  assert.equal(records[0].institutions.join(';'), 'University A;Institute B');
  assert.equal(records[1].institutions.join(), 'Institute B');
  assert.equal(records[2].author, '');
  assert.equal(records[2].institutions.join(), 'Unlinked University');
  assert(!JSON.stringify(records).includes('Reference University'));
});
test('publisher metadata never guesses the author from citation meta order', () => {
  const { api, win } = setup();
  const html = '<html><head><meta name="citation_author" content="Alice Li"><meta name="citation_author" content="Bob Smith"><meta name="citation_author_institution" content="University A">' +
    '<script type="application/ld+json">{"@type":"ScholarlyArticle","author":[{"name":"Alice Li","affiliation":{"name":"Institute B"}}]}</script></head><body></body></html>';
  const records = api.affiliations.fromHTML(html, win);
  assert.equal(records[0].author, '');
  assert.equal(records[1].author, 'Alice Li');
  assert.equal(records[1].institutions.join(), 'Institute B');
});
test('PDF extraction only produces unconfirmed institution candidates before Abstract', () => {
  const { api } = setup();
  const records = api.affiliations.fromPDFText('Paper title\n1 Department of Electronics, University A\ncontact@university.com\nAbstract\nUniversity B performed previous work.');
  assert.equal(records.length, 1);
  assert.equal(records[0].author, '');
  assert.equal(records[0].verified, false);
  assert(!records[0].institutions[0].includes('University B'));
});
test('institution classification is separate from groups and protects existing user tags', async () => {
  const { api } = setup(), support = api.affiliations, paper = item('通讯作者: Alice Li\n课题组手动指定: A\n课题组: A\nDOI: x');
  paper.tags.add('课题组/A'); paper.tags.add('阅读中'); paper.tags.add('机构/University A');
  await support.write(paper, { source: 'Crossref', records: [{ author: 'Alice Li', institutions: ['University A', 'Institute B'], verified: true }] });
  await support.classify(paper);
  assert(paper.tags.has('机构/University A')); assert(paper.tags.has('机构/Institute B'));
  assert(paper.tags.has('课题组/A')); assert(paper.tags.has('阅读中')); assert.match(paper.extra, /DOI: x/);
  const saves = paper.saves; await support.classify(paper); assert.equal(paper.saves, saves);
  await support.write(paper, { source: 'manual', records: [] }); await support.classify(paper);
  assert(paper.tags.has('机构/University A')); assert(!paper.tags.has('机构/Institute B'));
});
test('unconfirmed PDF candidate is not classified until manually confirmed', async () => {
  const { api } = setup(), support = api.affiliations, paper = item('');
  await support.write(paper, { source: 'PDF', records: [{ author: '', institutions: ['University A'], verified: false }] });
  assert.equal(await support.classify(paper), false); assert(!paper.tags.has('机构/University A'));
  await support.write(paper, { source: '手工确认', manual: true, records: support.parseEditor(support.editorText(support.read(paper))) });
  assert.equal(await support.classify(paper), true); assert(paper.tags.has('机构/University A'));
});
test('manual institutions survive refresh without any network request', async () => {
  const { api, win } = setup(), paper = item('');
  await api.affiliations.write(paper, { source: '手工确认', manual: true, records: [{ author: 'Alice Li', institutions: ['University A'] }] });
  api.request = async () => { throw Error('must not request'); };
  const result = await api.affiliations.fetch(paper, win, true);
  assert.equal(result.kept, true); assert.equal(result.data.records[0].institutions.join(), 'University A');
});
test('item pane displays mapped institutions and editor controls as text', async () => {
  const { api } = setup(), support = api.affiliations, paper = item('');
  await support.write(paper, { source: 'Crossref', records: [{ author: 'Alice Li', institutions: ['University A'], verified: true }] });
  const doc = new DOMParser().parseFromString('<html><body><div id="pane"></div></body></html>', 'text/html');
  support.renderPane({ body: doc.getElementById('pane'), item: paper, editable: true });
  assert.match(doc.body.textContent, /Alice Li：University A/);
  assert.equal(doc.querySelectorAll('button').length, 3);
  assert.match(doc.querySelector('textarea').value, /Alice Li \| University A/);
});
test('institution writes respect library permissions before touching Extra', async () => {
  const { api, Zotero } = setup(), paper = item('DOI: x');
  Zotero.Libraries.get = () => ({ editable: false });
  await assert.rejects(api.affiliations.write(paper, { records: [] }), /权限/);
  assert.equal(paper.extra, 'DOI: x'); assert.equal(paper.saves, 0);
});
test('IEEE affiliation footnote after Abstract is extracted while licensing university is excluded', () => {
  const { api } = setup();
  const text = 'Circuit paper\nAlice Li\nAbstract: Technical abstract.\nI. INTRODUCTION\nThe authors are with the Department of Engineering, Alpha University, City, USA (e-mail: alice@example.edu).\nAuthorized licensed use limited to: Other University. Downloaded from IEEE Xplore.';
  const records = api.affiliations.fromPDFText(text, [authors[0]]);
  assert(records.some(r => r.author === 'Alice Li' && r.institutions.includes('Alpha University') && r.verified));
  assert(!JSON.stringify(records).includes('Other University'));
});
test('unique initials map an explicitly named author but ambiguous aliases do not', () => {
  const { api } = setup();
  assert.equal(api.namesWithInitials('Corresponding author: A. Li', [authors[0]]).join(), 'Alice Li');
  assert.equal(api.namesWithInitials('Corresponding author: A. Li', [authors[0], { firstName: 'Anne', lastName: 'Li' }]).length, 0);
});
test('successive affiliation footnotes do not assign the previous authors to the next institution', () => {
  const { api } = setup();
  const text = 'Paper\nAbstract: Circuit.\nAlice Li is with Company Alpha, City, USA. Bob Smith is with Beta University, City, USA (e-mail: bob@example.edu).';
  const records = api.affiliations.fromPDFText(text, authors);
  const alice = records.filter(r => r.author === 'Alice Li');
  assert(!alice.some(r => r.institutions.includes('Beta University')));
  assert(records.some(r => r.author === 'Bob Smith' && r.institutions.includes('Beta University')));
});
test('conference company affiliation can be read when item creator metadata is missing', () => {
  const { api } = setup();
  const records = api.affiliations.fromPDFText('Conference paper\nAlice Li, Bob Smith\nExamplechip Technology, City, China\nAbstract\nTechnical text.', []);
  assert(records.some(r => r.verified && r.institutions.includes('Examplechip Technology')));
});
test('repository cover page is skipped to reach the actual thesis title page', async () => {
  const { api, Zotero } = setup();
  const paper = item('', [authors[0]]); paper.getAttachments = () => [1];
  Zotero.Items = { getAsync: async () => ({ attachmentContentType: 'application/pdf' }) };
  Zotero.Fulltext = { getItemCacheFile: () => ({ exists: () => true }) };
  Zotero.File = { getContentsAsync: async () => 'Repository cover\nItem Type Thesis\nLink to Item https://example.edu/1\fActual Thesis\nAlice Li\nSubmitted for Doctor of Philosophy\nUniversity of Example\nSubmitted 2020\fAbstract' };
  const records = await api.affiliations.fromLocalPDF(paper);
  assert(records.some(r => r.verified && r.institutions.includes('University of Example')));
});

test('PDF metadata and group are independent of the parent and sibling PDFs', async () => {
  const { api, Zotero, win } = setup();
  const parent = item('original parent', [authors[0]]);
  let columnRefreshes = 0;
  Zotero.ItemTreeManager = { refreshColumns: () => columnRefreshes++ };
  parent.id = 10;
  const pdf = Object.assign(item(), {
    id: 11, key: 'PDFONE', parentItemID: 10, isRegularItem: () => false,
    isAttachment: () => true, isPDFAttachment: () => true,
    getFilePathAsync: async () => 'E:\\docs\\reference.pdf'
  });
  const sibling = { ...pdf, id: 12, key: 'PDFTWO' };
  Zotero.PDFWorker = { getRecognizerData: async id => {
    assert.equal(id, pdf.id);
    return { pages: [[null, null, ['PDF text']]] };
  } };
  Zotero.Sync = { Runner: { getAPIClient: () => ({ makeRequest: async (method, url, options) => {
    assert.equal(method, 'POST');
    assert.match(url, /\/recognizer\/recognize$/);
    assert.equal(JSON.parse(options.body).fileName, 'reference.pdf');
    return { responseText: JSON.stringify({ title: 'Reference', doi: '10.1234/ref', year: 1986, container: 'Test Journal', authors: [authors[1]] }) };
  } }) } };
  win.ZoteroPane.getSelectedItems = () => [pdf, parent, sibling, pdf];
  assert.equal(api.selected(win).length, 3);
  let record = api.selected(win)[0];
  assert.equal(record.getField('DOI'), '');
  await api.lookupPDFMetadata(record);
  assert.equal(columnRefreshes, 1);
  assert.equal(record.getField('DOI'), '10.1234/ref');
  assert.equal(api.authors(record)[0].lastName, 'Smith');
  assert.equal(record.getAttachments().join(), '11');
  assert.equal(api.resolvePaper(sibling).getField('DOI'), '');
  win.ZoteroPane.getSelectedItems = () => [pdf];
  api.saveRules(1, [{ group: 'Reference group', authors: [] }]);
  await api.assignToExistingGroup(win, 'Reference group');
  assert.equal(columnRefreshes, 2);
  assert.equal(record.getField('extra').includes('Reference group'), true);
  assert.equal(pdf.tags.size, 1);
  assert.equal(parent.extra, 'original parent');
  assert.equal(parent.saves, 0);
  const nativeRows = [
    { title: 'Reference.pdf', firstCreator: '', year: '', existing: 'classification' },
    { title: 'Parent article', firstCreator: 'Li', year: '2001' },
    { title: 'Sibling.pdf', firstCreator: '', year: '' }
  ];
  const objects = [pdf, parent, sibling];
  const originalRowData = index => nativeRows[index];
  const view = { _getRowData: originalRowData, getRow: index => ({ ref: objects[index] }) };
  win.ZoteroPane.itemsView = view;
  api.attachTree(win);
  assert.equal(view._getRowData(0).title, 'Reference');
  assert.equal(view._getRowData(0).firstCreator, 'Bob Smith');
  assert.equal(view._getRowData(0).year, '1986');
  assert.equal(view._getRowData(0).publicationTitle, 'Test Journal');
  assert.equal(view._getRowData(0).existing, 'classification');
  assert.equal(view._getRowData(1), nativeRows[1]);
  assert.equal(view._getRowData(2), nativeRows[2]);
  api.detachTree(win);
  assert.equal(view._getRowData, originalRowData);
  Zotero.Utilities = { randomString: () => 'test-session' };
  Zotero.Integration = { sessions: {} };
  const normalSelection = win.ZoteroPane.getSelectedItems;
  let dialogCalls = 0;
  win.Zotero_File_Interface = { bibliographyFromItems: async () => {
    dialogCalls++;
    const references = win.ZoteroPane.getSelectedItems();
    assert.equal(references[0], parent);
    assert(references[1].isRegularItem());
    assert.equal(win.ZoteroPane.getSelectedItems, normalSelection);
    await Promise.resolve();
    const [sessionId, itemId] = references[1].id.split('/');
    const citation = Zotero.Integration.sessions[sessionId].embeddedItems[itemId];
    assert.equal(citation.title, 'Reference');
    assert.equal(citation.author[0].family, 'Smith');
    assert.equal(citation['container-title'], 'Test Journal');
    assert.equal(citation.issued['date-parts'][0][0], 1986);
  } };
  await api.createBibliography(win, [parent, pdf]);
  assert.equal(Object.getOwnPropertyNames(Zotero.Integration.sessions).length, 0);
  await assert.rejects(api.createBibliography(win, [parent, sibling]));
  assert.equal(dialogCalls, 1);
  Zotero.Items = { getAsync: async id => id === pdf.id ? pdf : sibling };
  parent.getAttachments = () => [11, 12];
  assert.equal((await api.evidenceAttachments(parent)).join(), '12');
  Zotero.Libraries.get = () => ({ editable: false });
  assert.throws(() => api.selected(win));
});
