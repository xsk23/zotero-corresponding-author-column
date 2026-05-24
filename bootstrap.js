var CorrespondingAuthorPro = {
  pluginID: null,
  registeredDataKey: null,

  async startup(data, reason) {
    this.pluginID = data.id;

    // 1. 注册显示列
    try {
      this.registeredDataKey = await Zotero.ItemTreeManager.registerColumn({
        dataKey: "correspondingAuthor",
        label: "通讯作者",
        pluginID: this.pluginID,
        enabledTreeIDs: ["main"],
        width: "140px",
        dataProvider: (item) => {
          try {
            if (!item || item.isAttachment() || item.isNote()) return "";
            return this.parseExtra(item.getField("extra") || "");
          } catch (e) { return ""; }
        }
      });
    } catch (e) {}

    // 2. 等待 UI 加载完成，插入右键菜单
    await Zotero.uiReadyPromise;
    this.addMenu();
  },

  addMenu() {
    try {
      let win = Zotero.getMainWindow();
      if (!win) return;

      let doc = win.document;
      let itemMenu = doc.getElementById("zotero-itemmenu");
      if (!itemMenu) return;
      
      // 防止重复添加
      if (doc.getElementById("ca-fetch-menuitem")) return;

      let menuitem = doc.createXULElement("menuitem");
      // 更改了菜单名称，提示用户这是本地极速版
      menuitem.setAttribute("label", "提取最后一位作者作为通讯作者 (极速版)");
      menuitem.setAttribute("id", "ca-fetch-menuitem");
      menuitem.setAttribute("class", "menuitem-iconic"); 

      menuitem.addEventListener("command", () => {
        this.fetchForSelectedItems();
      });

      itemMenu.appendChild(menuitem);
    } catch (e) {}
  },

  parseExtra(extra) {
    let patterns = [
      /通讯作者\s*[:：]\s*(.+?)$/im,
      /通信作者\s*[:：]\s*(.+?)$/im,
      /Corresponding\s+Author(?:s)?\s*[:：]\s*(.+?)$/im,
      /Correspondence\s*[:：]\s*(.+?)$/im,
      /^CA\s*[:：]\s*(.+?)$/im
    ];
    for (let pattern of patterns) {
      let match = extra.match(pattern);
      if (match && match[1]) return match[1].trim();
    }
    return "";
  },

  async fetchForSelectedItems() {
    try {
      let pane = Zotero.getActiveZoteroPane();
      if (!pane) return;

      let items = pane.getSelectedItems();
      if (!items || !items.length) {
        Zotero.alert(null, "提示", "请先在列表中选中至少一篇文献！");
        return;
      }

      let count = 0;
      for (let item of items) {
        if (!item.isRegularItem()) continue;

        // 获取该类型文献的主要作者类型ID（例如期刊的"author"）
        let primaryCreatorTypeID = 1; 
        try {
          primaryCreatorTypeID = Zotero.CreatorTypes.getPrimaryIDForType(item.itemTypeID);
        } catch (e) {}

        let creators = item.getCreators();
        if (!creators || creators.length === 0) continue;

        // 过滤出真正的作者
        let authors = creators.filter(c => c.creatorTypeID === primaryCreatorTypeID);
        if (authors.length === 0) authors = creators; // 如果没有标准author，退而求其次

        // 【核心逻辑】获取最后一位作者
        let lastAuthor = authors[authors.length - 1];
        let corresp = "";

        if (lastAuthor.fieldMode === 1) {
          // 机构名称
          corresp = lastAuthor.lastName;
        } else {
          let first = lastAuthor.firstName || "";
          let last = lastAuthor.lastName || "";
          
          // 智能判断中英文排版
          if (/[\u4e00-\u9fa5]/.test(first) || /[\u4e00-\u9fa5]/.test(last)) {
            corresp = last + first; // 中文：姓+名
          } else {
            corresp = first ? first + " " + last : last; // 英文：名+空格+姓
          }
        }

        if (corresp) {
          corresp = corresp.trim();
          let extra = item.getField("extra") || "";
          
          // 【智能清理】利用正则自动抹除之前旧版本抓错的通讯作者信息
          extra = extra.replace(/^通讯作者\s*[:：]\s*.*(?:\r\n|\n|$)/gim, "");
          extra = extra.replace(/^通信作者\s*[:：]\s*.*(?:\r\n|\n|$)/gim, "");
          extra = extra.replace(/^Corresponding\s+Author(?:s)?\s*[:：]\s*.*(?:\r\n|\n|$)/gim, "");
          extra = extra.replace(/^CA\s*[:：]\s*.*(?:\r\n|\n|$)/gim, "");

          // 重新写入正确的最后一个作者
          let newExtra = "通讯作者: " + corresp + "\n" + extra;
          item.setField("extra", newExtra.trim());
          await item.saveTx();
          count++;
        }
      }

      Zotero.alert(null, "完成", `已成功提取并更新 ${count} 篇文献的最后一位作者！`);
    } catch (e) {
      Zotero.alert(null, "错误", e.toString());
    }
  },

  async shutdown(data, reason) {
    if (reason === APP_SHUTDOWN) return;
    try {
      if (this.registeredDataKey) {
        await Zotero.ItemTreeManager.unregisterColumn(this.registeredDataKey);
      }
      let win = Zotero.getMainWindow();
      if (win) {
        let menuitem = win.document.getElementById("ca-fetch-menuitem");
        if (menuitem) menuitem.remove();
      }
    } catch (e) {}
  }
};

async function startup(data, reason) { await CorrespondingAuthorPro.startup(data, reason); }
async function shutdown(data, reason) { await CorrespondingAuthorPro.shutdown(data, reason); }
function install(data, reason) {}
function uninstall(data, reason) {}