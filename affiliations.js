var AffiliationSupport = {
  api: null, paneID: null,
  dataPattern: /^\s*作者机构数据\s*[:：]\s*(.*?)\s*$/i,
  summaryPattern: /^\s*作者机构\s*[:：]\s*(.*?)\s*$/i,
  tagsPattern: /^\s*机构自动标签\s*[:：]\s*(.*?)\s*$/i,
  clean(value) { return String(value || "").replace(/\s+/g, " ").trim(); },
  unique(values) {
    let seen = new Set();
    return values.map(v => this.clean(v)).filter(v => {
      let key = v.normalize("NFKC").toLocaleLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key); return true;
    });
  },
  read(item) {
    let extra = item.getField("extra") || "", raw = this.api.readField(extra, this.dataPattern);
    if (!raw) {
      let names = this.api.splitNames(this.api.readField(extra, this.summaryPattern));
      return { version: 1, source: names.length ? "已有 Extra 字段" : "", records: names.length ? [{ author: "", institutions: names, verified: true }] : [] };
    }
    let data = JSON.parse(raw);
    if (data.version !== 1 || !Array.isArray(data.records)) throw new Error("作者机构数据格式损坏，请先检查其它字段。");
    for (let record of data.records) {
      if (typeof record.author !== "string" || !Array.isArray(record.institutions) || record.institutions.some(n => typeof n !== "string")) throw new Error("作者机构记录格式错误。");
    }
    return data;
  },
  names(data, confirmedOnly = false) {
    return this.unique(data.records.filter(r => !confirmedOnly || r.verified !== false).flatMap(r => r.institutions));
  },
  async write(item, data) {
    if (!Zotero.Libraries.get(item.libraryID).editable) throw new Error("当前文库没有写入权限。");
    let records = data.records.map(r => ({ author: this.clean(r.author), institutions: this.unique(r.institutions), verified: r.verified !== false })).filter(r => r.institutions.length);
    let value = { version: 1, source: this.clean(data.source), manual: data.manual === true, records };
    let extra = this.api.replaceField(item.getField("extra"), this.dataPattern, "作者机构数据", JSON.stringify(value));
    extra = this.api.replaceField(extra, this.summaryPattern, "作者机构", this.names(value).join("; "));
    item.setField("extra", extra);
    await item.saveTx();
    return value;
  },
  async classify(item) {
    let data = this.read(item), names = this.names(data, true);
    let extra = item.getField("extra") || "";
    let owned = JSON.parse(this.api.readField(extra, this.tagsPattern) || "[]");
    if (!Array.isArray(owned) || owned.some(n => typeof n !== "string" || !n.startsWith("机构/"))) throw new Error("机构标签记录格式错误。");
    if (names.some(n => n.length > 240)) throw new Error("机构名称过长，请在作者机构窗格中精简名称后归类。");
    let desired = names.map(n => "机构/" + n), next = [], changed = false;
    for (let tag of owned) if (!desired.includes(tag) && item.hasTag(tag)) { item.removeTag(tag); changed = true; }
    for (let tag of desired) {
      if (!item.hasTag(tag)) { item.addTag(tag, 0); next.push(tag); changed = true; }
      else if (owned.includes(tag)) next.push(tag);
    }
    let updated = this.api.replaceField(extra, this.tagsPattern, "机构自动标签", next.length ? JSON.stringify(next) : "");
    if (updated !== extra) { item.setField("extra", updated); changed = true; }
    if (changed) await item.saveTx();
    return names.length > 0;
  },
  fromCrossref(json, doi) {
    let work = json.message || json;
    if (String(work.DOI || "").toLowerCase() !== doi.toLowerCase()) return [];
    return (work.author || []).map(a => ({
      author: a.name || this.api.displayName({ firstName: a.given, lastName: a.family }),
      institutions: this.unique((a.affiliation || []).map(f => f.name)), verified: true
    })).filter(r => r.institutions.length);
  },
  fromJATS(xml, win) {
    let doc = new win.DOMParser().parseFromString(xml, "application/xml");
    if (doc.querySelector("parsererror")) return [];
    let meta = doc.querySelector("article-meta");
    if (!meta) return [];
    let affiliations = new Map();
    for (let node of meta.querySelectorAll("aff")) {
      let institutions = [...node.querySelectorAll("institution")].map(n => n.textContent);
      let text = node.cloneNode(true); text.querySelectorAll("label").forEach(n => n.remove());
      affiliations.set(node.getAttribute("id"), this.unique(institutions.length ? [institutions.join(", ")] : [text.textContent]));
    }
    let records = [], linked = new Set();
    for (let author of meta.querySelectorAll('contrib[contrib-type="author"]')) {
      let names = [];
      for (let ref of author.querySelectorAll('xref[ref-type="aff"]')) {
        for (let id of String(ref.getAttribute("rid") || "").split(/\s+/)) {
          names.push(...(affiliations.get(id) || [])); linked.add(id);
        }
      }
      for (let aff of author.querySelectorAll("aff")) names.push(aff.textContent);
      let first = author.querySelector("given-names")?.textContent || "", last = author.querySelector("surname")?.textContent || "";
      if (names.length) records.push({ author: this.api.displayName({ firstName: first, lastName: last }), institutions: this.unique(names), verified: true });
    }
    // Keep unlinked affiliations, but never assign them to every author.
    for (let [id, names] of affiliations) if (!linked.has(id) && names.length) records.push({ author: "", institutions: names, verified: true });
    return records;
  },
  fromHTML(html, win) {
    let doc = new win.DOMParser().parseFromString(html, "text/html"), records = [];
    for (let meta of doc.querySelectorAll("meta[name]")) {
      let name = (meta.getAttribute("name") || "").toLowerCase(), content = this.clean(meta.getAttribute("content"));
      // Citation meta tags do not define a portable author-to-institution mapping.
      if (["citation_author_institution", "citation_author_affiliation"].includes(name) && content) records.push({ author: "", institutions: [content], verified: true });
    }
    // JSON-LD gives explicit author/affiliation associations.
    const visit = value => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) { value.forEach(visit); return; }
      if (value["@graph"]) visit(value["@graph"]);
      if (![].concat(value["@type"] || []).some(t => ["ScholarlyArticle", "Article", "MedicalScholarlyArticle"].includes(t))) return;
      for (let a of [].concat(value.author || [])) {
        if (typeof a !== "object") continue;
        let institutions = this.unique([].concat(a.affiliation || []).map(f => typeof f === "string" ? f : f.name));
        if (institutions.length) records.push({ author: this.clean(a.name), institutions, verified: true });
      }
    };
    for (let node of doc.querySelectorAll('script[type="application/ld+json"]')) {
      try { visit(JSON.parse(node.textContent)); } catch (e) { /* Skip invalid publisher JSON-LD. */ }
    }
    return records;
  },
  fromPDFText(text, authors = []) {
    // IEEE prints affiliations in a footnote AFTER the abstract. Never treat
    // the downloader's university in the IEEE licensing stamp as affiliation.
    let page = String(text || "").split("\f")[0].slice(0, 18000)
      .replace(/^.*Authorized licensed use limited to:.*$/gim, "")
      .replace(/(?<=[\p{L}])\d(?=[\s,])/gu, "");
    let institution = /\b(?:university|universiteit|institute|polytechnique|laborator(?:y|ies)|college|corporation|research center|research centre|CERN|INFN|Analog Devices|Texas Instruments|Broadcom|Microchip|MediaTek|Marvell|Qualcomm)\b|大学|研究所|研究院|实验室|有限公司/i;
    const extract = raw => {
      let value = this.clean(raw).split(/\(e-?mail|\bE-?mail|\bColor versions|\bDigital Object|https?:/i)[0];
      let parts = value.split(/[,;]+/).map(s => s.trim().replace(/^(?:the|and also with)\s+/i, "").replace(/^(?:[A-Z]{2,3}\s+)?\d+\s*(?=[A-Z])/, "")).filter(Boolean);
      let names = parts.filter(s => institution.test(s) && s !== "State College");
      if (!names.length && parts[0] && !/Department|School|Faculty/i.test(parts[0])) names = [parts[0]];
      return this.unique(names);
    };
    let records = [];
    for (let match of page.matchAll(/\b(?:are|is|was|were)\s+with\s+/gi)) {
      let before = page.slice(Math.max(0, match.index - 220), match.index);
      before = before.replace(/\b([A-Z])\./g, "$1").split(/[.!?]\s+(?=[A-Z])/).pop();
      let allAuthors = /\bThe authors?\s*$/i.test(before.trim());
      let mapped = this.api.namesWithInitials(before, authors);
      if (!allAuthors && !mapped.length) continue;
      let after = page.slice(match.index + match[0].length, match.index + match[0].length + 650)
        .split(/\(e-?mail|\bColor versions|\bDigital Object|\.\s+(?=[A-Z][^.]{0,70}\b(?:is|are|was|were) with\b)/i)[0];
      let names = extract(after);
      if (!names.length) continue;
      if (allAuthors) mapped = authors.map(a => this.api.displayName(a));
      for (let author of mapped.length ? mapped : [""]) records.push({ author, institutions: names, verified: true });
    }
    let front = page.split(/\babstract\b|摘要/i)[0];
    let lines = [...new Set([...front.split(/\r?\n/), ...page.split(/\r?\n/).filter(l => /Department|Dept|School|Faculty/i.test(l) && this.api.namesWithInitials(l, authors).length)])];
    for (let line of lines) {
      let companyHeader = /^[A-Z][\p{L} -]{1,45}(?:Technology|Technologies|Semiconductor|Microelectronics)\s*,/u.test(line.trim());
      if ((!institution.test(line) && !companyHeader) || /support|grant|copyright|licensed|download|https?:|©|[“”"]|\b(?:applications|experiment|testing|help|thanks|acknowledg|references|proposed|this|our|irradiat)\b/i.test(line)) continue;
      let value = line.replace(/\bEmail\s*:.*/i, "").replace(/^[\d*†‡\s]+/, "").replace(/^[a-d]\s+(?=[A-Z])/, "");
      for (let author of authors) value = value.replaceAll(this.api.displayName(author), " ");
      value = value.replace(/IEEE\s+Member|(?:Student|Senior)?\s*Member\s*,?\s*IEEE/gi, " ").replace(/^\s*and\s+/i, "");
      let names = extract(value);
      if (!names.length || names.some(n => n.length > 240)) continue;
      let authorHeader = companyHeader || (authors.length > 0 && (this.api.namesWithInitials(front, authors).length > 0 || /\b(?:Department|Dept|School|Faculty)\b/i.test(value) || /^(?:The\s+)?(?:[A-Z][\p{L}'’-]*\s+){0,8}(?:University|Institute)\b/u.test(value.trim()) || /^(?:Analog Devices|Texas Instruments|Broadcom|Microchip|Qualcomm)\b/.test(value.trim())));
      records.push({ author: "", institutions: names, verified: authorHeader });
    }
    let degree = page.match(/申请\s*([^()\n]{2,40}?大学)\s*[^()\n]{0,20}?学位论文/);
    if (degree) records.push({ author: "", institutions: [degree[1]], verified: true });
    if (records.some(r => r.verified)) return records;
    let candidates = front.split(/\r?\n/).map(s => this.clean(s).replace(/^[\d*†‡\s]+/, ""))
      .filter(s => s.length >= 8 && s.length <= 220 && /\b(?:university|institute|laborator(?:y|ies)|college|corporation|research center|research centre)\b|大学|研究所|研究院|实验室|有限公司/i.test(s))
      .filter(s => !/@|https?:|copyright|published by|IEEE|©/i.test(s));
    return this.unique(candidates).slice(0, 12).map(n => ({ author: "", institutions: [n], verified: false }));
  },
  async fromLocalPDF(item) {
    let records = [], fulltext = Zotero.Fulltext || Zotero.FullText;
    for (let id of await this.api.evidenceAttachments(item)) {
      let attachment = await Zotero.Items.getAsync(id);
      if (attachment.attachmentContentType !== "application/pdf") continue;
      try {
        let cache = fulltext.getItemCacheFile(attachment);
        if (!cache.exists() && await attachment.getFilePathAsync()) await fulltext.indexItems([id]);
        if (cache.exists()) {
          let text = await Zotero.File.getContentsAsync(cache, "utf-8", 30000);
          let first = text.split("\f")[0];
          if (/Item Type\s+Thesis|Link to Item/i.test(first)) text = text.split("\f").slice(1).join("\f");
          records.push(...this.fromPDFText(text, this.api.authors(item)));
        }
      } catch (e) { Zotero.logError(e); }
    }
    return records;
  },
  async fetch(item, win, refresh = false) {
    let existing = this.read(item);
    if (existing.manual || (!refresh && existing.records.length && existing.records.some(r => r.verified !== false))) return { data: existing, kept: true, errors: 0 };
    let records = [], source = "", errors = 0;
    let doi = String(item.getField("DOI") || "").replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").replace(/^doi:\s*/i, "").trim();
    if (/^10\.\d{4,9}\/\S+$/.test(doi)) {
      try {
        records = this.fromCrossref(JSON.parse(await this.api.request("https://api.crossref.org/works/" + encodeURIComponent(doi))), doi);
        source = "Crossref 出版商元数据";
      } catch (e) { errors++; Zotero.logError(e); }
      if (!records.length) {
        try {
          let query = JSON.parse(await this.api.request("https://www.ebi.ac.uk/europepmc/webservices/rest/search?format=json&query=" + encodeURIComponent('DOI:"' + doi + '"')));
          let record = (query.resultList?.result || []).find(r => r.pmcid && String(r.doi || "").toLowerCase() === doi.toLowerCase());
          if (record) records = this.fromJATS(await this.api.request("https://www.ebi.ac.uk/europepmc/webservices/rest/" + encodeURIComponent(record.pmcid) + "/fullTextXML"), win);
          source = "Europe PMC / JATS 作者机构标记";
        } catch (e) { errors++; Zotero.logError(e); }
      }
      if (!records.length && !this.api.sources) {
        try {
          records = this.fromHTML(await this.api.request("https://doi.org/" + encodeURI(doi).replace(/#/g, "%23").replace(/\?/g, "%3F")), win);
          source = "出版商页面结构化机构信息";
        } catch (e) { errors++; Zotero.logError(e); }
      }
    }
    if (!records.length && this.api.sources) {
      let result = await this.api.sources.lookup(item, win, { corresponding: false, institutions: true });
      await this.api.sources.saveTrace(item, result.trace);
      records = result.records; source = "文献来源网页：" + result.institutionsURL;
      errors += result.trace.pages.filter(p => p.status.startsWith("访问失败")).length;
    }
    if (!records.length) {
      records = await this.fromLocalPDF(item);
      source = records.some(r => r.verified !== false) ? "本地论文署名／作者单位脚注" : "本地 PDF 候选（需手动确认）";
    }
    if (!records.length || (existing.records.length && records.every(r => r.verified === false))) return { data: existing, missing: true, errors };
    let data = await this.write(item, { source, records });
    return { data, errors };
  },
  async fetchSelected(win) {
    let items = this.api.selected(win), found = 0, kept = 0, missing = 0, failed = 0, errors = 0;
    let progress = new Zotero.ProgressWindow({ closeOnClick: true });
    progress.changeHeadline("获取作者机构"); let status = new progress.ItemProgress("", "准备处理…"); progress.show();
    try {
      for (let [i, item] of items.entries()) {
        status.setText(`${i + 1}/${items.length}：${item.getField("title")}`); status.setProgress(i / items.length * 100);
        try {
          let result = await this.fetch(item, win); errors += result.errors;
          if (result.kept) kept++; else if (result.missing) missing++; else found++;
        } catch (e) { failed++; Zotero.logError(e); }
      }
      status.setProgress(100);
    } finally { progress.startCloseTimer(3000); }
    Zotero.alert(win, "作者机构获取完成", `新增 ${found} 篇，保留已有 ${kept} 篇，未找到 ${missing} 篇，失败 ${failed} 篇。网络失败 ${errors} 次。\n请在右侧“作者机构”窗格检查结果。PDF 候选须确认后才能按机构归类。`);
  },
  async classifySelected(win) {
    let count = 0, failed = 0, items = this.api.selected(win);
    for (let item of items) { try { if (await this.classify(item)) count++; } catch (e) { failed++; Zotero.logError(e); } }
    Zotero.alert(win, "按机构归类", `已按机构归类 ${count}/${items.length} 篇，失败 ${failed} 篇。\n通过“机构/名称”标签筛选。同篇论文支持多个机构，课题组归属不变。`);
  },
  editorText(data) { return data.records.map(r => r.author + " | " + r.institutions.join("; ")).join("\n"); },
  parseEditor(text) {
    return String(text || "").split(/\r?\n/).filter(s => s.trim()).map(line => {
      let i = line.indexOf("|");
      return { author: i < 0 ? "" : line.slice(0, i).trim(), institutions: this.unique(this.api.splitNames(i < 0 ? line : line.slice(i + 1))), verified: true };
    }).filter(r => r.institutions.length);
  },
  registerPane() {
    this.paneID = Zotero.ItemPaneManager.registerSection({
      paneID: "ca-pro-affiliations", pluginID: this.api.pluginID,
      header: { l10nID: "ca-pro-affiliations-header", icon: this.api.rootURI + "institution.svg" },
      sidenav: { l10nID: "ca-pro-affiliations-sidenav", icon: this.api.rootURI + "institution.svg" },
      onInit: ({ doc }) => { doc.l10n?.addResourceIds(["ca-pro-affiliations.ftl"]); },
      onItemChange: ({ item, setEnabled }) => { setEnabled(!!this.api.resolvePaper(item)); },
      onRender: props => this.renderPane(props)
    });
  },
  renderPane({ body, item, editable }) {
    body.replaceChildren();
    body._caAffItem = null;
    item = this.api.resolvePaper(item);
    if (!item) return;
    let doc = body.ownerDocument, win = doc.defaultView, make = tag => doc.createElementNS("http://www.w3.org/1999/xhtml", tag);
    let root = make("div"); root.style.cssText = "padding:10px;line-height:1.6;overflow-wrap:anywhere;";
    let title = make("strong"); title.textContent = item.attachment ? "PDF 附件元数据与作者机构" : "作者机构"; root.append(title);
    if (item.attachment) {
      let metadata = item.metadata;
      let summary = make("p");
      summary.textContent = metadata ? [
        metadata.fields.title, metadata.creators.map(author => this.api.displayName(author)).join("、"),
        metadata.fields.date, metadata.fields.publicationTitle, metadata.fields.DOI && "DOI " + metadata.fields.DOI
      ].filter(Boolean).join(" · ") : "尚未检索此 PDF 的书目元数据。";
      root.append(summary);
      let groups = this.api.readField(item.getField("extra"), this.api.groupPattern);
      if (groups) { let row = make("p"); row.textContent = "课题组：" + groups; root.append(row); }
    }
    let data;
    try { data = this.read(item); } catch (e) { let error = make("p"); error.textContent = e.message; root.append(error); body.append(root); return; }
    let source = make("p"); source.textContent = data.records.length ? "来源：" + data.source : "尚未获取作者机构。"; root.append(source);
    if (this.api.sources) {
      let trace = this.api.sources.readTrace(item);
      if (trace.discovery) { let row = make("p"); row.textContent = "来源查找：" + trace.discovery; root.append(row); }
      if (trace.localEvidence) { let row = make("p"); row.textContent = "原文证据：" + trace.localEvidence; root.append(row); }
      for (let page of trace.pages || []) {
        let url = this.api.sources.safeURL(page.url); if (!url) continue;
        let row = make("p"), link = make("a"); link.textContent = "打开来源网页"; link.href = url;
        link.addEventListener("click", event => { event.preventDefault(); Zotero.launchURL(url); });
        row.append(link, doc.createTextNode(" · " + page.status)); root.append(row);
      }
    }
    for (let record of data.records) {
      let row = make("p"); row.style.margin = "6px 0";
      row.textContent = `${record.author || "机构（未对应作者）"}：${record.institutions.join("；")}${record.verified === false ? "【PDF 候选，待确认】" : ""}`;
      root.append(row);
    }
    let hint = make("p"); hint.textContent = "编辑格式：作者 | 机构1; 机构2，每行一位作者；没有对应作者时可只填机构名称。"; root.append(hint);
    let editor = make("textarea"); editor.value = this.editorText(data); editor.setAttribute("aria-label", "编辑作者机构"); editor.style.cssText = "width:100%;min-height:100px;box-sizing:border-box;font:inherit;"; root.append(editor);
    let canEdit = editable !== false && Zotero.Libraries.get(item.libraryID).editable;
    editor.disabled = !canEdit;
    let status = make("div"); status.setAttribute("role", "status");
    const button = (label, action) => {
      let b = make("button"); b.type = "button"; b.textContent = label; b.disabled = !canEdit; b.style.cssText = "margin:6px 6px 6px 0;padding:5px 8px;";
      b.addEventListener("click", () => this.api.run(async () => {
        b.disabled = true; status.textContent = "处理中…";
        try { await action(); if (body.isConnected && body._caAffItem === item.id) this.renderPane({ body, item: item.attachment || item, editable }); }
        finally { b.disabled = !canEdit; }
      }, win)); root.append(b);
    };
    if (item.attachment) button("检索 PDF 元数据", () => this.api.lookupPDFMetadata(item));
    button("获取机构（保留手工）", async () => { let result = await this.fetch(item, win, true); if (result.missing) throw new Error("未找到可用机构信息，原记录已保留。可手动填写。" ); });
    button("保存并确认", () => this.write(item, { records: this.parseEditor(editor.value), source: "手工确认", manual: true }));
    button("按机构归类", () => this.classify(item));
    if (this.api.sources) button("从来源网页补全缺项", () => this.api.sources.fillItems([item], win));
    root.append(status); body._caAffItem = item.id; body.append(root);
  }
};
