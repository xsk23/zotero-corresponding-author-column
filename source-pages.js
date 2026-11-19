var SourcePageSupport = {
  api: null, cache: new Map(), repositoryURLs: new Map(), reviewed: [],
  tracePattern: /^\s*文献来源追踪\s*[:：]\s*(.*?)\s*$/i,
  normalize(value) { return String(value || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, ""); },
  doi(item) { return String(item.getField("DOI") || "").replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").replace(/^doi:\s*/i, "").trim(); },
  safeURL(value, base) {
    try {
      let url = new URL(value, base);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return "";
      if (/^(?:localhost|127\.|0\.|\[?::1\]?$)/i.test(url.hostname)) return "";
      url.hash = "";
      return url.href;
    } catch (e) { return ""; }
  },
  readTrace(item) {
    try { return JSON.parse(this.api.readField(item.getField("extra"), this.tracePattern) || "{}"); }
    catch (e) { return {}; }
  },
  async saveTrace(item, trace) {
    if (!trace.localEvidence && !trace.pages?.length && (!trace.discovery || trace.discovery.includes("题名过短"))) return;
    let extra = this.api.replaceField(item.getField("extra"), this.tracePattern, "文献来源追踪", JSON.stringify(trace));
    if (extra !== item.getField("extra")) { item.setField("extra", extra); await item.saveTx(); }
  },
  async candidates(item) {
    let urls = [], doi = this.doi(item);
    const add = value => { let url = this.safeURL(value); if (url && !urls.includes(url)) urls.push(url); };
    add(item.getField("url"));
    for (let id of await this.api.evidenceAttachments(item)) {
      try { add((await Zotero.Items.getAsync(id)).getField("url")); } catch (e) { /* Missing attachment. */ }
    }
    if (/^10\.\d{4,9}\/\S+$/.test(doi)) add("https://doi.org/" + doi);
    for (let url of this.repositoryURLs.get(doi.toLowerCase()) || []) add(url);
    return urls.slice(0, 5);
  },
  async paperIndex(item) {
    let doi = this.doi(item);
    if (!/^10\.\d{4,9}\/\S+$/.test(doi)) return null;
    let url = "https://api.openalex.org/works/https://doi.org/" + encodeURI(doi).replace(/#/g, "%23").replace(/\?/g, "%3F");
    let work = JSON.parse(await this.api.request(url));
    let workDoi = String(work.doi || "").replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "");
    if (workDoi.toLowerCase() !== doi.toLowerCase()) return null;
    let records = (work.authorships || []).map(a => ({
      author: a.author?.display_name || "", institutions: (a.institutions || []).map(i => i.display_name).filter(Boolean), verified: true
    })).filter(r => r.institutions.length);
    let repositories = (work.locations || []).filter(l => l.is_oa && l.source?.type === "repository").map(l => this.safeURL(l.landing_page_url)).filter(Boolean);
    this.repositoryURLs.set(doi.toLowerCase(), repositories);
    // Never use an author's present-day profile or infer correspondence here.
    return { records, url };
  },
  matchingWork(works, item) {
    let title = this.normalize(item.getField("title"));
    if (title.length < 8) return null;
    let authors = this.api.authors(item), year = String(item.getField("date") || "").match(/\b(?:19|20)\d{2}\b/)?.[0];
    let matches = works.filter(work => {
      if (![].concat(work.title || []).some(t => this.normalize(t) === title)) return false;
      let authorMatch = authors.length && (work.author || []).some(a => authors.some(c => this.normalize(c.lastName) && this.normalize(c.lastName) === this.normalize(a.family)));
      let workYear = String(work.published?.["date-parts"]?.[0]?.[0] || work.issued?.["date-parts"]?.[0]?.[0] || "");
      return authorMatch || (year && year === workYear);
    });
    let dois = [...new Set(matches.map(w => String(w.DOI || "").toLowerCase()).filter(Boolean))];
    return dois.length === 1 ? matches.find(w => String(w.DOI).toLowerCase() === dois[0]) : null;
  },
  async discover(item) {
    let title = String(item.getField("title") || "").trim();
    if (title.length < 8) return { urls: [], reason: "题名过短，未自动检索" };
    let json = JSON.parse(await this.api.request("https://api.crossref.org/works?rows=5&query.title=" + encodeURIComponent(title)));
    let work = this.matchingWork(json.message?.items || [], item);
    if (!work) return { urls: [], reason: "题名检索结果未通过题名＋作者或年份核对，或存在多个候选" };
    let urls = [work.resource?.primary?.URL, work.URL, "https://doi.org/" + work.DOI].map(v => this.safeURL(v)).filter(Boolean);
    return { urls: [...new Set(urls)], doi: work.DOI, reason: "题名及作者／年份已核对" };
  },
  async requestPage(url) {
    let response = await Zotero.HTTP.request("GET", url, { responseType: "text", timeout: 14000 });
    let text = response.responseText || "";
    if (!text.trim()) { let error = new Error("网站返回空页面"); error.status = response.status; error.kind = "empty"; throw error; }
    if (/verify that you.re not a robot|javascript is disabled|enable javascript.{0,80}reload|verify you are human/i.test(text.slice(0, 10000))) {
      let error = new Error("网站要求浏览器验证"); error.kind = "verification"; throw error;
    }
    if (text.length > 3000000) throw new Error("页面过大，请打开来源网页核对");
    let type = response.getResponseHeader?.("Content-Type") || "";
    if (/application\/pdf/i.test(type) || text.startsWith("%PDF")) throw new Error("来源是 PDF，请使用本地 PDF 提取或打开网页核对");
    return { html: text, url: this.safeURL(response.responseURL) || url };
  },
  redirect(doc, base) {
    let refresh = [...doc.querySelectorAll('meta[http-equiv]')].find(n => (n.getAttribute("http-equiv") || "").toLowerCase() === "refresh");
    let match = refresh?.getAttribute("content")?.match(/url\s*=\s*["']?(.+?)["']?\s*$/i);
    let url = match && this.safeURL(match[1], base);
    return url && url !== base ? url : "";
  },
  identity(doc, item, expectedDoi) {
    let dois = [...doc.querySelectorAll('meta[name="citation_doi"], meta[name="dc.identifier"], meta[name="DC.Identifier"], meta[property="prism:doi"]')]
      .map(n => (n.getAttribute("content") || "").replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").trim().toLowerCase()).filter(n => /^10\.\d{4,9}\//.test(n));
    let xmlDoi = doc.querySelector('article-id[pub-id-type="doi"]')?.textContent?.trim().toLowerCase();
    if (xmlDoi) dois.push(xmlDoi);
    if (expectedDoi && dois.length) return dois.includes(expectedDoi.toLowerCase()) ? "DOI 已核对" : "";
    let title = this.normalize(item.getField("title"));
    if (title.length < 8) return "";
    let pageNames = [...doc.querySelectorAll('meta[name="citation_author"], .author-name')].map(n => n.getAttribute("content") || n.textContent);
    let authors = this.api.authors(item);
    if (authors.length && pageNames.length && !this.api.namesInText(pageNames.join("; "), authors).length) return "";
    let titles = [...doc.querySelectorAll('meta[name="citation_title"], meta[property="og:title"]')].map(n => n.getAttribute("content"));
    titles.push(doc.querySelector("article-title, h1")?.textContent);
    return titles.some(t => this.normalize(t) === title) ? "论文题名已核对" : "";
  },
  parsePage(html, item, win, expectedDoi) {
    let xml = /<article-meta[\s>]/i.test(html) && /<article-id[\s>]/i.test(html);
    let doc = new win.DOMParser().parseFromString(html, xml ? "application/xml" : "text/html");
    let identity = this.identity(doc, item, expectedDoi);
    if (!identity) return { identity: "", corresponding: [], records: [], doc };
    if (xml) return { identity, corresponding: this.api.fromJATS(html, win), records: this.api.affiliations.fromJATS(html, win), doc };
    let authors = this.api.authors(item).slice();
    for (let node of doc.querySelectorAll('meta[name="citation_author"]')) {
      let name = (node.getAttribute("content") || "").trim();
      if (!name) continue;
      let parts = name.includes(",") ? name.split(",").map(s => s.trim()) : null;
      let words = name.split(/\s+/);
      authors.push(parts ? { firstName: parts.slice(1).join(" "), lastName: parts[0] } : { firstName: words.slice(0, -1).join(" "), lastName: words[words.length - 1] });
    }
    let corresponding = this.api.fromHTML(html, authors, win);
    let records = this.api.affiliations.fromHTML(html, win);
    doc.querySelectorAll("script, style, nav, footer, .references, #references, .ref-list, [role='doc-bibliography']").forEach(n => n.remove());
    let nameNode = node => node.closest('li, [itemprop="author"], .author, .author-block')?.querySelector('.author-name, [itemprop="name"], [data-test="author-name"]');
    const clean = value => String(value || "").replace(/\s+/g, " ").replace(/[,;\s]+$/, "").trim();
    for (let node of doc.querySelectorAll('[id*="correspond" i], [class*="correspond" i], [data-test*="correspond" i], [role="doc-correspondence"]')) {
      if (node.textContent.length > 1200) continue;
      corresponding.push(...this.api.namesInText(node.textContent, authors));
      let local = nameNode(node);
      if (local) corresponding.push(clean(local.textContent));
    }
    let metadataNames = this.api.affiliations.names({ records });
    for (let node of doc.querySelectorAll('[id*="affiliat" i], [class*="affiliat" i], [itemprop="affiliation"], [data-test*="affiliat" i]')) {
      if (node.textContent.length > 1400) continue;
      let children = [...node.querySelectorAll("li, p")].filter(n => n.textContent.trim());
      let blocks = children.length ? children : [node];
      for (let block of blocks) {
        let copy = block.cloneNode(true); copy.querySelectorAll('.type, .label, sup, button').forEach(n => n.remove());
        let text = clean(copy.textContent).replace(/^affiliations?\s*[:：]?\s*/i, "");
        if (text.length < 5 || text.length > 800 || /@|https?:\/\//.test(text)) continue;
        let mapped = metadataNames.filter(n => this.normalize(text).includes(this.normalize(n)));
        let local = nameNode(block);
        let author = local ? clean(local.textContent) : "";
        records.push({ author, institutions: mapped.length ? mapped : [text], verified: true });
      }
    }
    corresponding = [...new Set(corresponding.map(clean).filter(Boolean))];
    let mapped = new Set(records.filter(r => r.author).flatMap(r => r.institutions).map(n => this.normalize(n)));
    records = records.map(r => r.author ? r : { ...r, institutions: r.institutions.filter(n => !mapped.has(this.normalize(n))) }).filter(r => r.institutions.length);
    let seen = new Set();
    records = records.filter(r => {
      let key = JSON.stringify([r.author, r.institutions]);
      if (seen.has(key)) return false; seen.add(key); return true;
    });
    return { identity, corresponding, records, doc };
  },
  followLinks(doc, base) {
    let links = [];
    for (let node of doc.querySelectorAll('a[href], link[href]')) {
      let href = node.getAttribute("href");
      if (!href || href.startsWith("#")) continue;
      let label = [node.textContent, node.getAttribute("title"), node.getAttribute("type")].join(" ");
      if (!/author information|author details|affiliations|full[ -]?text|application\/(?:xml|jats)|作者信息|作者单位/i.test(label)) continue;
      let url = this.safeURL(href, base);
      if (url && new URL(url).hostname === new URL(base).hostname && url !== base) links.push(url);
    }
    return [...new Set(links)].slice(0, 2);
  },
  async lookup(item, win, wants = { corresponding: true, institutions: true }) {
    let urls = await this.candidates(item), expectedDoi = this.doi(item);
    let key = JSON.stringify([expectedDoi, item.getField("title"), urls, wants]);
    let cached = this.cache.get(key);
    if (cached && Date.now() - cached.time < 300000) return cached.result;
    let result = { corresponding: [], records: [], correspondingURL: "", institutionsURL: "", trace: { pages: [], discovery: "", sourceURL: "" } }, seen = new Set();
    let discoveryDone = false;
    while (result.trace.pages.length < 6) {
      if (!urls.length) {
        if (discoveryDone) break;
        discoveryDone = true;
        try {
          let discovery = await this.discover(item); result.trace.discovery = discovery.reason;
          expectedDoi = expectedDoi || discovery.doi || ""; urls.push(...discovery.urls);
        } catch (e) { result.trace.discovery = "题名检索未成功"; }
        if (!urls.length) break;
      }
      let url = urls.shift(); if (seen.has(url)) continue; seen.add(url);
      try {
        let page = await this.requestPage(url);
        let parsed = this.parsePage(page.html, item, win, expectedDoi);
        let redirect = this.redirect(parsed.doc, page.url);
        if (redirect) { result.trace.pages.push({ url: page.url, status: "来源页包含网页跳转，继续跟进" }); urls.unshift(redirect); continue; }
        if (!parsed.identity) { result.trace.pages.push({ url: page.url, status: "未通过论文身份核对" }); continue; }
        let entry = { url: page.url, status: parsed.identity + (parsed.corresponding.length || parsed.records.length ? "；已提取页面信息" : "；未找到明确标记"), corresponding: parsed.corresponding.length, institutions: parsed.records.length };
        result.trace.pages.push(entry);
        if (parsed.corresponding.length) { result.corresponding = [...new Set([...result.corresponding, ...parsed.corresponding])]; result.correspondingURL = page.url; }
        if (parsed.records.length) { result.records.push(...parsed.records); result.institutionsURL = page.url; }
        if (parsed.corresponding.length || parsed.records.length) result.trace.sourceURL = page.url;
        let complete = (!wants.corresponding || result.corresponding.length) && (!wants.institutions || result.records.length);
        if (complete) break;
        urls.unshift(...this.followLinks(parsed.doc, page.url));
      } catch (e) { result.trace.pages.push({ url, status: e.kind === "verification" ? "网站要求浏览器验证，未获得论文内容" : e.kind === "empty" ? `网站返回空页面（${e.status || 0}，未获得论文内容）` : e.status ? `访问失败（${e.status}）` : "访问失败或页面不可解析" }); }
    }
    if ((!wants.corresponding || result.corresponding.length) && (!wants.institutions || result.records.length)) this.cache.set(key, { time: Date.now(), result });
    if (this.cache.size > 40) this.cache.delete(this.cache.keys().next().value);
    return result;
  },
  async fillItems(items, win) {
    let authors = 0, institutions = 0, failed = 0, missing = 0, keptCA = 0, keptAff = 0, missingCA = 0, missingAff = 0;
    let progress = new Zotero.ProgressWindow({ closeOnClick: true }); progress.changeHeadline("从文献来源网页补全信息");
    let status = new progress.ItemProgress("", "查找来源网页…"); progress.show();
    try {
      for (let [i, item] of items.entries()) {
        status.setText(`${i + 1}/${items.length}：${item.getField("title")}`); status.setProgress(i / items.length * 100);
        try {
          if (!Zotero.Libraries.get(item.libraryID).editable) throw new Error("当前文库没有写入权限。");
          let oldCA = this.api.parseExtra(item.getField("extra"));
          let oldAff = this.api.affiliations.read(item);
          let needCA = !oldCA || this.api.readField(item.getField("extra"), this.api.sourcePattern).startsWith("估计");
          let needAff = !oldAff.manual && (!oldAff.records.length || oldAff.records.every(r => r.verified === false));
          if (!needCA) keptCA++;
          if (!needAff) keptAff++;
          if (!needCA && !needAff) continue;
          let result = { corresponding: [], records: [], correspondingURL: "", institutionsURL: "", trace: this.readTrace(item) };
          result.trace.pages = result.trace.pages || [];
          if (needCA) {
            result.corresponding = await this.api.fromPDF(item, this.api.authors(item));
            if (result.corresponding.length) result.correspondingURL = "本地论文明确通讯标记";
          }
          if (needAff) {
            result.records = (await this.api.affiliations.fromLocalPDF(item)).filter(r => r.verified !== false);
            if (result.records.length) result.institutionsURL = "本地论文首页署名／作者单位脚注";
          }
          if (result.corresponding.length || result.records.length) result.trace.localEvidence = "已从所保存论文中的明确通讯标记或作者单位区域提取";
          if (needAff && !result.records.length) {
            let reviewed = this.reviewed.find(r => r.doi.toLowerCase() === this.doi(item).toLowerCase() && this.normalize(r.title) === this.normalize(item.getField("title")));
            if (reviewed) {
              result.records = reviewed.records; result.institutionsURL = reviewed.url;
              result.trace.pages.push({ url: reviewed.url, status: "已人工核对会议原始日程：" + reviewed.evidence });
            }
          }
          if (needAff && !result.records.length) {
            try {
              let indexed = await this.paperIndex(item);
              if (indexed?.records.length) {
                result.records = indexed.records; result.institutionsURL = indexed.url;
                result.trace.pages.push({ url: indexed.url, status: "OpenAlex 论文级 DOI 记录，机构信息请核对原文" });
              }
            } catch (e) { /* Continue to publication/repository pages. */ }
          }
          if ((needCA && !result.corresponding.length) || (needAff && !result.records.length)) {
            let web = await this.lookup(item, win, { corresponding: needCA && !result.corresponding.length, institutions: needAff && !result.records.length });
            if (!result.corresponding.length) { result.corresponding = web.corresponding; result.correspondingURL = web.correspondingURL; }
            if (!result.records.length) { result.records = web.records; result.institutionsURL = web.institutionsURL; }
            let pages = [...result.trace.pages, ...web.trace.pages];
            let uniquePages = new Map(pages.map(p => [p.url + "|" + p.status, p]));
            result.trace = { ...web.trace, pages: [...uniquePages.values()].slice(-12), localEvidence: result.trace.localEvidence };
          }
          await this.saveTrace(item, result.trace);
          const source = value => /^https?:/.test(value) ? "文献来源：" + value : value;
          if (needCA && result.corresponding.length) { await this.api.writeAuthor(item, result.corresponding.join("; "), source(result.correspondingURL)); authors++; }
          if (needAff && result.records.length) { await this.api.affiliations.write(item, { source: source(result.institutionsURL), records: result.records }); institutions++; }
          if (needCA && !result.corresponding.length) missingCA++;
          if (needAff && !result.records.length) missingAff++;
          if ((needCA && !result.corresponding.length) || (needAff && !result.records.length)) missing++;
        } catch (e) { failed++; Zotero.logError(e); }
      }
      status.setProgress(100);
    } finally { progress.startCloseTimer(3000); }
    Zotero.alert(win, "补全完成", `通讯作者：新增 ${authors} 篇，保留已有 ${keptCA} 篇，仍缺 ${missingCA} 篇。\n机构：新增 ${institutions} 篇，保留已有 ${keptAff} 篇，仍缺 ${missingAff} 篇。\n有缺项 ${missing} 篇，处理失败 ${failed} 篇。\n本地论文、论文级索引和网页来源均已标明；网站空响应或跳转页会单独说明。`);
  }
};
