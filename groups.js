/* global window, document */
window.addEventListener("load", () => {
  const { api, libraryID } = window.arguments[0];
  const zotero = window.arguments[0].Zotero;
  const $ = id => document.getElementById(id);
  const element = name => document.createElementNS("http://www.w3.org/1999/xhtml", name);
  const status = message => { $("status").textContent = message; };
  let dirty = false;
  function addRow(rule = { group: "", authors: [] }) {
    const row = element("div"), group = element("input"), authors = element("textarea"), remove = element("button");
    row.className = "row";
    group.value = rule.group;
    group.setAttribute("aria-label", "课题组名称");
    authors.value = rule.authors.join("; ");
    authors.setAttribute("aria-label", "通讯作者及别名");
    remove.textContent = "删除";
    remove.addEventListener("click", () => { row.remove(); dirty = true; });
    row.addEventListener("input", () => { dirty = true; });
    row.append(group, authors, remove);
    $("rows").appendChild(row);
  }
  function collect() {
    return [...$("rows").children].map(row => ({ group: row.children[0].value.trim(), authors: api.splitNames(row.children[1].value) }));
  }
  function save() { api.saveRules(libraryID, collect()); dirty = false; }
  $("library").textContent = "当前文库：" + zotero.Libraries.get(libraryID).name;
  try { for (const rule of api.loadRules(libraryID)) addRow(rule); }
  catch (e) { status(e.message); $("save").disabled = $("apply").disabled = true; }
  $("add").addEventListener("click", () => { addRow(); dirty = true; });
  $("save").addEventListener("click", () => {
    if (api.busy) { status("另一个操作正在处理，请稍候。"); return; }
    try { save(); status("规则已保存。点击“保存并归类”可更新当前文库已有文献。"); }
    catch (e) { status(e.message); }
  });
  $("apply").addEventListener("click", async () => {
    if (api.busy) { status("另一个操作正在处理，请稍候。"); return; }
    api.busy = true;
    const controls = [...document.querySelectorAll("button, input, textarea")];
    controls.forEach(control => { control.disabled = true; });
    try {
      save(); status("正在归类当前文库…");
      const items = (await zotero.Items.getAll(libraryID, true, false)).filter(item => item.isRegularItem() && !item.deleted);
      status(await api.classifyItems(items));
    } catch (e) { status(e.message); }
    finally { controls.forEach(control => { control.disabled = false; }); api.busy = false; }
  });
  $("close").addEventListener("click", () => window.close());
  window.addEventListener("beforeunload", event => {
    if (dirty) { event.preventDefault(); event.returnValue = "规则尚未保存"; }
  });
});
