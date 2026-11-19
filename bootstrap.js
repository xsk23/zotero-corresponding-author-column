var CorrespondingAuthorPro = {
  pluginID: null, rootURI: null, chromeHandle: null, columns: [], windows: new Set(), dialogs: new Set(), busy: false, affiliations: null, sources: null,
  prefKey: "extensions.correspondingAuthorPro.groups.v1",
  caPattern: /^\s*(?:通讯作者|通信作者|Corresponding\s+Authors?|Correspondence|CA)\s*[:：]\s*(.*?)\s*$/i,
  groupPattern: /^\s*(?:课题组|Research\s+Groups?)\s*[:：]\s*(.*?)\s*$/i,
  sourcePattern: /^\s*通讯作者来源\s*[:：]\s*(.*?)\s*$/i,
  tagPattern: /^\s*课题组自动标签\s*[:：]\s*(.*?)\s*$/i,
  manualGroupPattern: /^\s*课题组手动指定\s*[:：]\s*(.*?)\s*$/i,
  attachmentRecords: new WeakMap(),
  treeHooks: new Map(),
  bibliographyMenus: new Map(),

  async startup(data) {
    this.pluginID = data.id;
    this.rootURI = data.rootURI;
    this.chromeHandle = Components.classes["@mozilla.org/addons/addon-manager-startup;1"]
      .getService(Components.interfaces.amIAddonManagerStartup)
      .registerChrome(Services.io.newURI(data.rootURI + "manifest.json"), [["content", "ca-pro", "./"]]);
    try {
      let scope = { Zotero };
      Services.scriptloader.loadSubScript(data.rootURI + "affiliations.js", scope, "UTF-8");
      this.affiliations = scope.AffiliationSupport;
      this.affiliations.api = this;
      this.affiliations.registerPane();
    } catch (e) { Zotero.logError(e); }
    try {
      let scope = { Zotero };
      Services.scriptloader.loadSubScript(data.rootURI + "source-pages.js", scope, "UTF-8");
      this.sources = scope.SourcePageSupport; this.sources.api = this;
      Services.scriptloader.loadSubScript(data.rootURI + "reviewed-sources.js", scope, "UTF-8");
      this.sources.reviewed = scope.ReviewedSources;
    } catch (e) { Zotero.logError(e); }
    for (let [dataKey, label, provider] of [
      ["correspondingAuthor", "通讯作者", item => this.parseExtra(item.getField("extra"))],
      ["researchGroup", "课题组", item => this.readField(item.getField("extra"), this.groupPattern)],
      ["authorInstitutions", "作者机构", item => this.affiliations ? this.affiliations.names(this.affiliations.read(item)).join("; ") : ""]
    ]) {
      try {
        this.columns.push(await Zotero.ItemTreeManager.registerColumn({
          dataKey, label, pluginID: this.pluginID, enabledTreeIDs: ["main"], width: "160px",
          dataProvider: item => {
            try { let paper = this.resolvePaper(item); return paper ? provider(paper) : ""; }
            catch (e) { return ""; }
          }
        }));
      } catch (e) { Zotero.logError(e); }
    }
    await Zotero.uiReadyPromise;
    for (let win of Zotero.getMainWindows()) this.addMenu(win);
  },
  readField(extra, pattern) {
    return String(extra || "").split(/\r?\n/).map(line => line.match(pattern))
      .filter(Boolean).map(match => match[1].trim()).filter(Boolean).join("; ");
  },
  attachTree(win) {
    let view = win.ZoteroPane?.itemsView;
    if (typeof view?._getRowData !== "function" || typeof view.getRow !== "function") return;
    if (this.treeHooks.get(win)?.view === view) return;
    this.detachTree(win);
    let api = this, original = view._getRowData;
    let ownDescriptor = Object.getOwnPropertyDescriptor(view, "_getRowData");
    function wrapped(index) {
      let row = original.apply(this, arguments);
      let item = this.getRow(index)?.ref;
      try {
        let metadata = api.resolvePaper(item)?.metadata;
        if (!metadata) return row;
        let { fields, creators } = metadata;
        let authors = creators.map(creator => api.displayName(creator)).filter(Boolean).join("; ");
        let result = { ...row };
        for (let field of ["title", "date", "publicationTitle", "publisher", "volume", "issue", "pages", "language", "DOI", "ISBN"]) {
          if (fields[field]) result[field] = String(fields[field]);
        }
        if (authors) result.firstCreator = authors;
        let year = String(fields.date || "").match(/^\d{4}/)?.[0];
        if (year) result.year = year;
        return result;
      } catch (e) {
        Zotero.logError(e);
        return row;
      }
    }
    view._getRowData = wrapped;
    this.treeHooks.set(win, { view, wrapped, ownDescriptor });
    Zotero.ItemTreeManager?.refreshColumns?.();
  },
  detachTree(win) {
    let hook = this.treeHooks.get(win);
    if (!hook) return;
    let { view, wrapped, ownDescriptor } = hook;
    if (view._getRowData === wrapped) {
      if (ownDescriptor) Object.defineProperty(view, "_getRowData", ownDescriptor);
      else delete view._getRowData;
    }
    this.treeHooks.delete(win);
  },
  parseExtra(extra) { return this.readField(extra, this.caPattern); },
  replaceField(extra, pattern, label, value) {
    let lines = String(extra || "").split(/\r?\n/).filter(line => !pattern.test(line));
    if (value) lines.unshift(label + ": " + value);
    return lines.join("\n").trim();
  },
  splitNames(value) { return String(value || "").split(/[;；\n]+/).map(s => s.trim()).filter(Boolean); },
  normalize(value) {
    return String(value || "").normalize("NFKC").toLocaleLowerCase().replace(/[\s.,，。·\-‐‑–—'’]/g, "");
  },
  displayName(creator) {
    let first = creator.firstName || "", last = creator.lastName || "";
    if (creator.fieldMode === 1) return last.trim();
    return (/[\u3400-\u9fff]/.test(first + last) ? last + first : [first, last].filter(Boolean).join(" ")).trim();
  },
  authors(item) {
    // Editors and translators are not fallback authors.
    return item.getCreators().filter(c => c.creatorTypeID === Zotero.CreatorTypes.getID("author"));
  },
  loadRules(libraryID) {
    let raw = Zotero.Prefs.get(this.prefKey, true);
    if (!raw) return [];
    let all = JSON.parse(raw);
    if (!all || typeof all !== "object" || Array.isArray(all)) throw new Error("课题组配置格式损坏，请先备份配置。");
    let rules = all[String(libraryID)] || [];
    if (!Array.isArray(rules)) throw new Error("课题组规则格式损坏。");
    return this.validateRules(rules);
  },
  validateRules(rules) {
    let seen = new Map();
    for (let rule of rules) {
      rule.group = String(rule.group || "").trim();
      rule.authors = [...new Set((rule.authors || []).map(a => String(a).trim()).filter(Boolean))];
      if (!rule.group || /[;；\r\n]/.test(rule.group)) throw new Error("课题组名称不能为空，也不能包含分号或换行。");
      for (let name of rule.authors) {
        let key = this.normalize(name);
        if (!key || /[;；\r\n]/.test(name)) throw new Error("作者名称无效，请用分号分隔多个作者。");
        if (seen.has(key) && seen.get(key) !== rule.group) throw new Error(`作者“${name}”同时属于两个课题组，请消除冲突。`);
        seen.set(key, rule.group);
      }
    }
    return rules;
  },
  saveRules(libraryID, rules) {
    this.validateRules(rules);
    let raw = Zotero.Prefs.get(this.prefKey, true), all = raw ? JSON.parse(raw) : {};
    if (!all || typeof all !== "object" || Array.isArray(all)) throw new Error("课题组配置格式损坏。");
    all[String(libraryID)] = rules;
    Zotero.Prefs.set(this.prefKey, JSON.stringify(all), true);
  },
  matchGroups(names, rules) {
    let keys = new Set(this.splitNames(names).map(name => this.normalize(name)));
    return [...new Set(rules.filter(rule => rule.authors.some(name => keys.has(this.normalize(name)))).map(rule => rule.group))];
  },
  async classifyItem(item, rules, forceSave = false) {
    let extra = item.getField("extra") || "";
    let manual = this.readField(extra, this.manualGroupPattern);
    let groups = manual ? [...new Set(this.splitNames(manual))] : this.matchGroups(this.parseExtra(extra), rules);
    // Only tags recorded as created by this plugin are removed on reclassification.
    let oldTags = JSON.parse(this.readField(extra, this.tagPattern) || "[]");
    if (!Array.isArray(oldTags) || oldTags.some(t => typeof t !== "string")) throw new Error("课题组自动标签记录格式错误。");
    let desired = groups.map(group => "课题组/" + group), owned = [], changed = forceSave;
    for (let tag of oldTags) {
      if (!desired.includes(tag) && item.hasTag(tag)) { item.removeTag(tag); changed = true; }
    }
    for (let tag of desired) {
      if (!item.hasTag(tag)) { item.addTag(tag, 0); owned.push(tag); changed = true; }
      else if (oldTags.includes(tag)) owned.push(tag);
    }
    let updated = this.replaceField(extra, this.groupPattern, "课题组", groups.join("; "));
    updated = this.replaceField(updated, this.tagPattern, "课题组自动标签", owned.length ? JSON.stringify(owned) : "");
    if (updated !== extra) { item.setField("extra", updated); changed = true; }
    if (changed) await item.saveTx();
    return groups.length > 0;
  },
  addMenu(win) {
    this.attachTree(win);
    let doc = win.document, menu = doc.getElementById("zotero-itemmenu");
    if (!menu || doc.getElementById("ca-pro-menu")) return;
    this.attachBibliographyMenu(win, menu);
    let root = doc.createXULElement("menu"), popup = doc.createXULElement("menupopup");
    root.id = "ca-pro-menu";
    root.setAttribute("label", "通讯作者与课题组");
    popup.addEventListener("popupshowing", event => {
      if (event.target === popup) this.attachTree(win);
    });
    root.appendChild(popup);
    let assignMenu = doc.createXULElement("menu"), assignPopup = doc.createXULElement("menupopup");
    assignMenu.setAttribute("label", "将选中文献归入已有课题组");
    assignMenu.id = "ca-existing-groups-menu";
    assignMenu.appendChild(assignPopup);
    assignPopup.addEventListener("popupshowing", event => {
      if (event.target !== assignPopup) return;
      this.populateGroupMenu(win, assignPopup);
    });
    popup.appendChild(assignMenu);
    for (let [label, action] of [
      ["检索 PDF 附件自身的元数据", () => this.lookupSelectedPDFs(win)],
      ["用 DOI 检索 PDF 附件元数据…", () => this.lookupPDFByDOI(win)],
      ["从来源网页补全通讯作者和机构", () => this.sources.fillItems(this.selected(win), win)],
      ["获取选中文献的作者机构", () => this.affiliations.fetchSelected(win)],
      ["按作者机构归类选中文献", () => this.affiliations.classifySelected(win)],
      ["清除选中文献的手动归组，恢复作者规则", () => this.clearManualGroups(win)],
      ["识别通讯作者（优先明确标记）", () => this.identifySelected(win, false)],
      ["重新识别旧结果（保留手工确认）", () => this.identifySelected(win, false, true)],
      ["使用末位作者估计（仅填补空白）", () => this.identifySelected(win, true)],
      ["手动设置选中文献的通讯作者…", () => this.setManual(win)],
      ["设置通讯作者与课题组对应关系…", () => this.assignSelected(win)],
      ["按规则归类选中文献", () => this.classifySelected(win)],
      ["管理课题组与作者对应关系…", () => this.openManager(win)]
    ]) {
      let child = doc.createXULElement("menuitem");
      child.setAttribute("label", label);
      child.addEventListener("command", () => { this.run(action, win); });
      popup.appendChild(child);
    }
    menu.appendChild(root);
    this.windows.add(win);
  },
  attachBibliographyMenu(win, menu) {
    let command = menu.querySelector(".zotero-menuitem-create-bibliography");
    if (!command) return;
    const selection = () => this.pane(win).getSelectedItems();
    const includesPDF = items => items.some(item => this.resolvePaper(item)?.attachment);
    const onPopup = event => {
      if (event.target !== menu || !includesPDF(selection())) return;
      command.setAttribute("hidden", "false");
      command.setAttribute("disabled", "false");
    };
    const onCommand = event => {
      if (event.target !== command) return;
      let items = selection();
      if (!includesPDF(items)) return;
      event.stopImmediatePropagation();
      event.preventDefault();
      void this.run(() => this.createBibliography(win, items), win);
    };
    menu.addEventListener("popupshowing", onPopup);
    menu.addEventListener("command", onCommand, true);
    this.bibliographyMenus.set(win, () => {
      menu.removeEventListener("popupshowing", onPopup);
      menu.removeEventListener("command", onCommand, true);
    });
  },
  attachmentCSL(metadata) {
    let { fields, creators, type } = metadata;
    let types = {
      "journal-article": "article-journal", "proceedings-article": "paper-conference",
      "book": "book", "book-chapter": "chapter", "dissertation": "thesis",
      "report": "report", "posted-content": "article", "preprint": "article"
    };
    let csl = { type: types[type] || (fields.ISBN && !fields.publicationTitle ? "book" : "article-journal") };
    for (let [source, target] of [
      ["title", "title"], ["DOI", "DOI"], ["url", "URL"], ["ISBN", "ISBN"],
      ["publicationTitle", "container-title"], ["publisher", "publisher"],
      ["volume", "volume"], ["issue", "issue"], ["pages", "page"]
    ]) {
      if (fields[source]) csl[target] = String(fields[source]);
    }
    if (creators.length) csl.author = creators.map(creator => creator.fieldMode === 1
      ? { literal: creator.lastName }
      : { given: creator.firstName, family: creator.lastName });
    let date = String(fields.date || "").match(/^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?$/);
    if (date) csl.issued = { "date-parts": [date.slice(1).filter(Boolean).map(Number)] };
    return csl;
  },
  async createBibliography(win, items) {
    const sessionID = "ca-pdf-" + Zotero.Utilities.randomString(16);
    const embeddedItems = Object.create(null);
    let references = [], missing = [];
    for (let item of items) {
      let record = this.resolvePaper(item);
      if (!record) continue;
      if (!record.attachment) { references.push(item); continue; }
      let metadata = record.metadata;
      if (!metadata?.fields.title) {
        missing.push(item.getField("title"));
        continue;
      }
      embeddedItems[item.id] = this.attachmentCSL(metadata);
      references.push({ id: sessionID + "/" + item.id, isRegularItem: () => true });
    }
    if (missing.length) throw new Error("请先检索以下 PDF 的元数据，再创建参考文献表：\n" + missing.join("\n"));
    if (!references.length) throw new Error("请先选中可引用的文献。");

    // Native bibliography options support embedded CSL IDs. Supply the selection
    // only for the command's synchronous selection read and never save fake items.
    let pane = win.ZoteroPane_Local || this.pane(win);
    let descriptor = Object.getOwnPropertyDescriptor(pane, "getSelectedItems");
    let sessions = Zotero.Integration.sessions;
    Object.defineProperty(sessions, sessionID, { value: { embeddedItems }, configurable: true });
    try {
      let pending;
      try {
        let original = pane.getSelectedItems;
        pane.getSelectedItems = function () {
          if (descriptor) Object.defineProperty(pane, "getSelectedItems", descriptor);
          else delete pane.getSelectedItems;
          return references;
        };
        pending = win.Zotero_File_Interface.bibliographyFromItems();
        if (pane.getSelectedItems !== original) throw new Error("当前 Zotero 版本无法读取附件引文。");
      } finally {
        if (descriptor) Object.defineProperty(pane, "getSelectedItems", descriptor);
        else delete pane.getSelectedItems;
      }
      await pending;
    } finally {
      delete sessions[sessionID];
    }
  },
  async run(action, win) {
    if (this.busy) { Zotero.alert(win, "处理中", "上一项操作尚未完成，请稍候。"); return; }
    this.busy = true;
    try { await action(); }
    catch (e) { Zotero.logError(e); Zotero.alert(win, "操作未完成", String(e.message || e)); }
    finally { this.busy = false; }
  },
  pane(win) { return win.ZoteroPane || Zotero.getActiveZoteroPane(); },
  resolvePaper(item) {
    if (!item || item.deleted) return null;
    if (item.isRegularItem?.()) return item;
    if (!item.isAttachment?.()) return null;
    if (!(item.isPDFAttachment?.() || item.attachmentContentType === "application/pdf")) return null;
    if (this.attachmentRecords.has(item)) return this.attachmentRecords.get(item);
    const pref = `extensions.correspondingAuthorPro.pdf.${item.libraryID}.${item.key}`;
    const read = () => JSON.parse(Zotero.Prefs.get(pref, true) || "{}");
    let pendingExtra;
    const record = {
      attachment: item,
      get id() { return item.id; },
      get libraryID() { return item.libraryID; },
      get deleted() { return item.deleted; },
      get metadata() { return read().metadata; },
      getField(field) {
        if (field === "extra") return pendingExtra ?? read().extra ?? "";
        return this.metadata?.fields[field] || (field === "title" || field === "url" ? item.getField(field) : "");
      },
      setField(field, value) {
        if (field !== "extra") throw new Error("附件仅支持写入插件字段。");
        pendingExtra = value;
      },
      getCreators() { return this.metadata?.creators || []; },
      getAttachments() { return [item.id]; },
      hasTag(tag) { return item.hasTag(tag); },
      addTag(tag, type) { return item.addTag(tag, type); },
      removeTag(tag) { return item.removeTag(tag); },
      async saveTx() {
        try {
          await item.saveTx();
          if (pendingExtra !== undefined) {
            Zotero.Prefs.set(pref, JSON.stringify({ ...read(), extra: pendingExtra }), true);
            Zotero.ItemTreeManager?.refreshColumns?.();
          }
        } finally { pendingExtra = undefined; }
      },
      saveMetadata(metadata) {
        Zotero.Prefs.set(pref, JSON.stringify({ ...read(), metadata }), true);
        Zotero.ItemTreeManager?.refreshColumns?.();
      }
    };
    this.attachmentRecords.set(item, record);
    return record;
  },
  async lookupPDFMetadata(record) {
    let attachment = record.attachment;
    let path = await attachment.getFilePathAsync();
    if (!path) throw new Error("PDF 尚未下载到本地。");
    let data = await Zotero.PDFWorker.getRecognizerData(attachment.id, true);
    if (!data?.pages?.some(page => page[2]?.length)) throw new Error("PDF 没有可识别的文本，请先做 OCR。");
    data.fileName = path.split(/[\\/]/).pop();
    let base = Zotero.Prefs.get("recognize.url");
    if (!base) base = (Zotero.Prefs.get("services.url") || "https://services.zotero.org/").replace(/\/+$/, "") + "/recognizer/";
    let client = Zotero.Sync.Runner.getAPIClient();
    let response = await client.makeRequest("POST", base.replace(/\/+$/, "") + "/recognize", {
      successCodes: [200], headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data), noAPIKey: true
    });
    let result = JSON.parse(response.responseText);
    if (!result?.title && !result?.doi) throw new Error("未查到这份 PDF 的书目元数据。");
    let fields = {
      title: result.title, DOI: result.doi, url: result.url,
      date: result.year, publicationTitle: result.container, abstractNote: result.abstract,
      volume: result.volume, issue: result.issue, pages: result.pages, ISBN: result.isbn
    };
    let creators = (result.authors || []).map(author => ({
      firstName: author.firstName || "", lastName: author.lastName || "",
      creatorTypeID: Zotero.CreatorTypes.getID("author")
    }));
    if (record.deleted || !Zotero.Libraries.get(record.libraryID).editable) throw new Error("附件已删除或文库不可写入。");
    record.saveMetadata({ fields, creators, type: result.type || (result.arxiv ? "preprint" : undefined) });
    return fields.title || fields.DOI;
  },
  async lookupSelectedPDFs(win) {
    let records = this.selected(win).filter(item => item.attachment);
    if (!records.length) throw new Error("请先选中需要检索元数据的 PDF 附件。");
    let results = [];
    for (let record of records) {
      try { results.push("已识别：" + await this.lookupPDFMetadata(record)); }
      catch (e) { Zotero.logError(e); results.push(record.attachment.getField("title") + "：" + (e.message || e)); }
    }
    Zotero.alert(win, "PDF 附件元数据", results.join("\n"));
  },
  async lookupPDFByDOI(win) {
    let items = this.selected(win);
    if (items.length !== 1 || !items[0].attachment) throw new Error("请只选中一份 PDF 附件。");
    let record = items[0];
    let value = this.prompt(win, "检索 PDF 附件元数据", "请输入这份 PDF 对应的 DOI。", record.getField("DOI"));
    if (!value) return;
    let doi = value.replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i, "");
    if (!/^10\.\d{4,9}\/\S+$/.test(doi)) throw new Error("DOI 格式无效。");
    let { message: work } = JSON.parse(await this.request("https://api.crossref.org/works/" + encodeURIComponent(doi)));
    if (work?.DOI?.toLowerCase() !== doi.toLowerCase() || !work.title?.[0]) throw new Error("未找到匹配此 DOI 的书目信息。");
    let fields = {
      title: work.title[0], DOI: work.DOI, url: work.URL,
      date: work.issued?.["date-parts"]?.[0]?.join("-"), publicationTitle: work["container-title"]?.[0],
      volume: work.volume, issue: work.issue, pages: work.page
    };
    let creators = (work.author || []).map(author => ({
      firstName: author.given || "", lastName: author.family || author.name || "",
      creatorTypeID: Zotero.CreatorTypes.getID("author")
    }));
    if (record.deleted || !Zotero.Libraries.get(record.libraryID).editable) throw new Error("附件已删除或文库不可写入。");
    record.saveMetadata({ fields, creators, type: work.type });
    Zotero.alert(win, "PDF 附件元数据", "已识别：" + fields.title);
  },
  async evidenceAttachments(item) {
    if (item.attachment) return item.getAttachments();
    let attachments = [];
    const normalize = value => String(value || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    const doi = value => String(value || "").trim().toLowerCase().replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/, "");
    for (let id of item.getAttachments()) {
      let attachment = await Zotero.Items.getAsync(id);
      if (!attachment || attachment.deleted) continue;
      let fields = this.resolvePaper(attachment)?.metadata?.fields;
      if (fields) {
        let parentDOI = doi(item.getField("DOI")), attachmentDOI = doi(fields.DOI);
        let parentTitle = normalize(item.getField("title")), attachmentTitle = normalize(fields.title);
        let matches = parentDOI && attachmentDOI ? parentDOI === attachmentDOI : parentTitle && parentTitle === attachmentTitle;
        if (!matches) continue;
      }
      attachments.push(id);
    }
    return attachments;
  },
  selected(win) {
    let items = [...new Set(this.pane(win).getSelectedItems().map(item => this.resolvePaper(item)).filter(Boolean))];
    if (!items.length) throw new Error("请先选中文献或 PDF 附件。");
    if (items.some(item => !Zotero.Libraries.get(item.libraryID).editable)) throw new Error("所选文献所在文库没有写入权限。");
    return items;
  },
  prompt(win, title, message, initial = "") {
    let value = { value: initial };
    return Services.prompt.prompt(win, title, message, value, null, {}) ? value.value.trim() : null;
  },
  async classifyItems(items) {
    let count = 0, failures = 0;
    for (let item of items) {
      try { if (await this.classifyItem(item, this.loadRules(item.libraryID))) count++; }
      catch (e) { Zotero.logError(e); failures++; }
    }
    return `已归类 ${count} / ${items.length} 篇文献。失败 ${failures} 篇。\n保留手动指定的课题组；没有匹配规则的其余文献将清除原自动分类。`;
  },
  async classifySelected(win) { Zotero.alert(win, "课题组归类", await this.classifyItems(this.selected(win))); },
  populateGroupMenu(win, popup) {
    popup.replaceChildren();
    try {
      let items = this.selected(win);
      let libraries = [...new Set(items.map(item => item.libraryID))];
      let groups = [...new Set(this.loadRules(libraries[0]).map(rule => rule.group))]
        .filter(group => libraries.every(id => this.loadRules(id).some(rule => rule.group === group)));
      for (let group of groups) {
        let entry = win.document.createXULElement("menuitem");
        entry.setAttribute("label", group);
        entry.addEventListener("command", () => this.run(() => this.assignToExistingGroup(win, group, items), win));
        popup.appendChild(entry);
      }
      if (!groups.length) {
        let entry = win.document.createXULElement("menuitem");
        entry.setAttribute("label", "尚无课题组，请先在“管理课题组”中创建");
        entry.setAttribute("disabled", "true");
        popup.appendChild(entry);
      }
    } catch (e) {
      let entry = win.document.createXULElement("menuitem");
      entry.setAttribute("label", e.message);
      entry.setAttribute("disabled", "true");
      popup.appendChild(entry);
    }
  },
  async assignToExistingGroup(win, group, items = this.selected(win)) {
    // Recheck permissions and the saved group before writing any selected item.
    if (!items.length || items.some(item => item.deleted || !Zotero.Libraries.get(item.libraryID).editable)) {
      throw new Error("所选文献不可写入，请重新选择。");
    }
    let rules = new Map();
    for (let id of new Set(items.map(item => item.libraryID))) {
      let current = this.loadRules(id);
      if (!current.some(rule => rule.group === group)) throw new Error("课题组已被删除或更名，请重新打开菜单选择。");
      rules.set(id, current);
    }
    let failed = 0;
    for (let item of items) {
      try {
        item.setField("extra", this.replaceField(item.getField("extra"), this.manualGroupPattern, "课题组手动指定", group));
        await this.classifyItem(item, rules.get(item.libraryID), true);
      } catch (e) { Zotero.logError(e); failed++; }
    }
    Zotero.alert(win, "批量归组完成", `已将 ${items.length - failed} 篇文献归入“${group}”，失败 ${failed} 篇。\n手动归组优先于作者规则；再次选择其它课题组可更改归属。`);
  },
  async clearManualGroups(win) {
    let items = this.selected(win), failed = 0;
    for (let item of items) {
      try {
        let rules = this.loadRules(item.libraryID);
        item.setField("extra", this.replaceField(item.getField("extra"), this.manualGroupPattern, "课题组手动指定", ""));
        // Persist marker removal even if the effective classification does not change.
        await this.classifyItem(item, rules, true);
      } catch (e) { Zotero.logError(e); failed++; }
    }
    Zotero.alert(win, "恢复作者规则", `已处理 ${items.length - failed} 篇，失败 ${failed} 篇。`);
  },
  async assignSelected(win) {
    let items = this.selected(win);
    let names = [...new Set(items.flatMap(item => this.splitNames(this.parseExtra(item.getField("extra")))))];
    if (!names.length) throw new Error("所选文献还没有通讯作者，请先识别或手动设置。");
    let group = this.prompt(win, "归入课题组", "请输入课题组名称。以下作者将全部归入此组（已有对应关系将更新）：\n" + names.join("；"));
    if (group === null) return;
    let configurations = [...new Set(items.map(i => i.libraryID))].map(id => {
      let rules = this.loadRules(id), keys = new Set(names.map(n => this.normalize(n)));
      rules = rules.map(rule => ({ group: rule.group, authors: rule.authors.filter(n => !keys.has(this.normalize(n))) }));
      let target = rules.find(rule => rule.group === group);
      if (target) target.authors.push(...names); else rules.push({ group, authors: names.slice() });
      this.validateRules(rules);
      return [id, rules];
    });
    for (let [id, rules] of configurations) this.saveRules(id, rules);
    Zotero.alert(win, "已保存对应关系", await this.classifyItems(items) + "\n同作者的其它文献可在管理窗口中批量归类。");
  },
  async setManual(win) {
    let items = this.selected(win);
    let value = this.prompt(win, "手动设置通讯作者", "输入已确认的通讯作者姓名；多位作者用分号分隔。将应用到所有选中文献。",
      items.length === 1 ? this.parseExtra(items[0].getField("extra")) : "");
    if (value === null) return;
    let names = this.splitNames(value).join("; ");
    if (!names) throw new Error("通讯作者不能为空。");
    let failed = 0;
    for (let item of items) {
      try { await this.writeAuthor(item, names, "手工确认"); }
      catch (e) { Zotero.logError(e); failed++; }
    }
    Zotero.alert(win, "完成", `已设置 ${items.length - failed} 篇，失败 ${failed} 篇。`);
  },
  async writeAuthor(item, names, source) {
    let extra = this.replaceField(item.getField("extra"), this.caPattern, "通讯作者", names);
    extra = this.replaceField(extra, this.sourcePattern, "通讯作者来源", source);
    item.setField("extra", extra);
    await item.saveTx();
    await this.classifyItem(item, this.loadRules(item.libraryID));
  },
  namesInText(text, authors) {
    // Full-name and token boundaries prevent surname-only and substring matches.
    let clean = value => String(value || "").normalize("NFKC").toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
    let normalized = " " + clean(text) + " ", matches = [];
    for (let author of authors) {
      let name = this.displayName(author);
      if (!name || (!author.firstName && !/[\u3400-\u9fff]/.test(name))) continue;
      let variants = [name, [author.lastName, author.firstName].filter(Boolean).join(" ")];
      if (variants.some(v => /[\u3400-\u9fff]/.test(v) ? normalized.includes(clean(v)) : normalized.includes(" " + clean(v) + " "))) matches.push(name);
    }
    return [...new Set(matches)];
  },
  fromMarkedText(text, authors) {
    let result = [];
    let pattern = /(?:corresponding\s+authors?\s*[:：.\-]?|correspondence\s+(?:should\s+be\s+)?(?:addressed\s+to|to)|通讯作者\s*[:：]?|通信作者\s*[:：]?)\s*[^\n\r]{0,220}/gi;
    for (let match of String(text || "").matchAll(pattern)) result.push(...this.namesWithInitials(match[0], authors));
    return [...new Set(result)];
  },
  namesWithInitials(text, authors) {
    let result = this.namesInText(text, authors);
    let clean = value => String(value || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
    let normalized = " " + clean(text) + " ", aliases = new Map();
    for (let author of authors) {
      if (!author.firstName || !author.lastName) continue;
      let initials = clean(author.firstName).split(/\s+/).map(s => s[0]);
      for (let alias of [initials.join(" ") + " " + clean(author.lastName), initials[0] + " " + clean(author.lastName)]) {
        if (!aliases.has(alias)) aliases.set(alias, new Set());
        aliases.get(alias).add(this.displayName(author));
      }
    }
    for (let [alias, names] of aliases) if (names.size === 1 && normalized.includes(" " + alias + " ")) result.push(...names);
    return [...new Set(result)];
  },
  async fromPDF(item, authors) {
    let results = [], fulltext = Zotero.Fulltext || Zotero.FullText;
    for (let id of await this.evidenceAttachments(item)) {
      let attachment = await Zotero.Items.getAsync(id);
      if (attachment.attachmentContentType !== "application/pdf") continue;
      try {
        let cache = fulltext.getItemCacheFile(attachment);
        if (!cache.exists() && await attachment.getFilePathAsync()) await fulltext.indexItems([id]);
        if (cache.exists()) results.push(...this.fromMarkedText(await Zotero.File.getContentsAsync(cache, "utf-8", 60000), authors));
      } catch (e) { Zotero.logError(e); }
    }
    return [...new Set(results)];
  },
  async request(url) {
    let response = await Zotero.HTTP.request("GET", url, { timeout: 12000, responseType: "text" });
    return response.responseText;
  },
  fromJATS(xml, win) {
    let doc = new win.DOMParser().parseFromString(xml, "application/xml");
    if (doc.querySelector("parsererror")) return [];
    let result = [];
    for (let contributor of doc.querySelectorAll('article-meta contrib[contrib-type="author"]')) {
      if (contributor.getAttribute("corresp") !== "yes" && !contributor.querySelector('xref[ref-type="corresp"]')) continue;
      let first = contributor.querySelector("given-names")?.textContent || "";
      let last = contributor.querySelector("surname")?.textContent || "";
      if (last) result.push(this.displayName({ firstName: first, lastName: last }));
    }
    return [...new Set(result)];
  },
  async fromEuropePMC(doi, win) {
    let query = await this.request("https://www.ebi.ac.uk/europepmc/webservices/rest/search?format=json&query=" + encodeURIComponent('DOI:"' + doi + '"'));
    let results = JSON.parse(query).resultList?.result || [];
    let record = results.find(r => r.pmcid && String(r.doi || "").toLowerCase() === doi.toLowerCase());
    if (!record) return [];
    return this.fromJATS(await this.request("https://www.ebi.ac.uk/europepmc/webservices/rest/" + encodeURIComponent(record.pmcid) + "/fullTextXML"), win);
  },
  fromHTML(html, authors, win) {
    let doc = new win.DOMParser().parseFromString(html, "text/html"), result = [];
    doc.querySelectorAll("script, style, nav, footer, .references, #references, [role='doc-bibliography']").forEach(n => n.remove());
    for (let node of doc.querySelectorAll('[id*="corresp"], [class*="corresp"], [data-test*="corresp"], [role="doc-correspondence"]')) {
      if (node.textContent.length < 1200) result.push(...this.namesInText(node.textContent, authors));
    }
    // Preserve block boundaries when reading a detached DOM (innerText is unavailable).
    doc.querySelectorAll("p, div, li, section, br").forEach(n => n.appendChild(doc.createTextNode("\n")));
    result.push(...this.fromMarkedText(doc.body?.textContent || "", authors));
    return [...new Set(result)];
  },
  async identifySelected(win, estimate, refresh = false) {
    let items = this.selected(win), stats = { found: 0, kept: 0, missing: 0, failed: 0, network: 0 };
    let progress = new Zotero.ProgressWindow({ closeOnClick: true });
    progress.changeHeadline(estimate ? "估计通讯作者" : "识别通讯作者");
    let status = new progress.ItemProgress("", "准备处理…");
    progress.show();
    try {
      for (let [index, item] of items.entries()) {
        status.setText(`${index + 1} / ${items.length}：${item.getField("title")}`);
        status.setProgress(index / items.length * 100);
        try {
          let extra = item.getField("extra"), existing = this.parseExtra(extra), source = this.readField(extra, this.sourcePattern);
          if (existing && (estimate || source === "手工确认" || (!refresh && !source.startsWith("估计")))) {
            await this.classifyItem(item, this.loadRules(item.libraryID));
            stats.kept++; continue;
          }
          let authors = this.authors(item), names = [], origin = "";
          if (estimate) {
            if (authors.length) names = [this.displayName(authors[authors.length - 1])].filter(Boolean);
            origin = "估计（末位作者，未经确认）";
          } else {
            names = await this.fromPDF(item, authors);
            origin = "本地 PDF 明确通讯标记（文本匹配，请核对）";
            let doi = String(item.getField("DOI") || "").replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").replace(/^doi:\s*/i, "").trim();
            if (!names.length && /^10\.\d{4,9}\/\S+$/.test(doi)) {
              try { names = await this.fromEuropePMC(doi, win); origin = "Europe PMC / JATS 通讯标记"; }
              catch (e) { stats.network++; Zotero.logError(e); }
              if (!names.length && !this.sources) {
                try {
                  names = this.fromHTML(await this.request("https://doi.org/" + encodeURI(doi).replace(/#/g, "%23").replace(/\?/g, "%3F")), authors, win);
                  origin = "出版商页面通讯标记（文本匹配，请核对）";
                } catch (e) { stats.network++; Zotero.logError(e); }
              }
            }
            if (!names.length && this.sources) {
              let result = await this.sources.lookup(item, win, { corresponding: true, institutions: false });
              await this.sources.saveTrace(item, result.trace);
              names = result.corresponding;
              origin = "文献来源网页：" + result.correspondingURL;
            }
          }
          if (names.length) { await this.writeAuthor(item, names.join("; "), origin); stats.found++; }
          else stats.missing++;
        } catch (e) { stats.failed++; Zotero.logError(e); }
        if (win.closed) break;
      }
      status.setProgress(100);
      status.setText("处理完成");
    } finally { progress.startCloseTimer(3000); }
    Zotero.alert(win, "通讯作者处理完成", `新识别 ${stats.found} 篇，保留已有 ${stats.kept} 篇，未找到新结果 ${stats.missing} 篇，失败 ${stats.failed} 篇。\n网络请求未成功 ${stats.network} 次。\n未找到明确标记时不会自动使用末位作者；需要时可使用单独的估计菜单。\n默认保留旧版本和手工填写的结果。要更新旧结果，请使用“重新识别旧结果”；要锁定手工结果，请使用“手动设置”菜单。`);
  },
  openManager(win) {
    let libraryID = this.pane(win).getSelectedLibraryID();
    if (!Zotero.Libraries.get(libraryID).editable) throw new Error("当前文库没有写入权限。");
    for (let dialog of this.dialogs) {
      if (!dialog.closed && dialog.arguments[0].libraryID === libraryID) { dialog.focus(); return; }
    }
    let dialog = win.openDialog("chrome://ca-pro/content/groups.xhtml", "", "chrome,centerscreen,resizable,width=820,height=640", { api: this, libraryID, Zotero });
    this.dialogs.add(dialog);
    dialog.addEventListener("unload", () => this.dialogs.delete(dialog), { once: true });
  },
  async shutdown(data, reason) {
    if (reason === APP_SHUTDOWN) return;
    for (let dialog of this.dialogs) if (!dialog.closed) dialog.close();
    this.dialogs.clear();
    for (let win of this.treeHooks.keys()) this.detachTree(win);
    for (let detach of this.bibliographyMenus.values()) detach();
    this.bibliographyMenus.clear();
    for (let win of this.windows) if (!win.closed) win.document.getElementById("ca-pro-menu")?.remove();
    this.windows.clear();
    for (let key of this.columns) await Zotero.ItemTreeManager.unregisterColumn(key);
    this.columns = [];
    if (this.affiliations?.paneID) Zotero.ItemPaneManager.unregisterSection(this.affiliations.paneID);
    this.chromeHandle?.destruct();
    this.chromeHandle = null;
  }
};
async function startup(data, reason) { await CorrespondingAuthorPro.startup(data, reason); }
async function shutdown(data, reason) { await CorrespondingAuthorPro.shutdown(data, reason); }
function onMainWindowLoad({ window }) { CorrespondingAuthorPro.addMenu(window); }
function onMainWindowUnload({ window }) {
  CorrespondingAuthorPro.detachTree(window);
  CorrespondingAuthorPro.bibliographyMenus.get(window)?.();
  CorrespondingAuthorPro.bibliographyMenus.delete(window);
  CorrespondingAuthorPro.windows.delete(window);
}
function install() {}
function uninstall() {}
