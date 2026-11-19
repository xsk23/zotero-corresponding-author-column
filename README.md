# Corresponding Author Pro for Zotero

在 Zotero 识别通讯作者、查找作者机构，并按机构或课题组整理文献。挂在其他论文下面的参考 PDF 也可以独立检索、归类和引用。

## 安装

1. 在 [GitHub Releases](https://github.com/xsk23/zotero-corresponding-author-column/releases/latest) 下载 `corresponding-author-pro-1.10.0.xpi`。
2. 在 Zotero 打开「工具 → 插件」，点击齿轮并选择「从文件安装插件」。
3. 按提示重启 Zotero。可右键点击文献列表表头，勾选「通讯作者」「作者机构」和「课题组」。

插件清单允许 Zotero 7 至 10 安装。附件列表和引用菜单依赖 Zotero 的桌面内部接口，发布前应在目标版本上实测。当前通过 Releases 手动更新。

## 使用

- **识别通讯作者和机构**。选中文献，右键打开「通讯作者与课题组」。可以从本地 PDF 或来源网页查找署名及机构。通讯作者默认要求明确证据，也可以手动确认。
- **整理课题组**。在菜单中管理作者与课题组的规则，再应用规则或手动归组。可按「课题组」列查看，也可通过对应标签筛选。
- **识别附件**。展开父条目，右键选择需要检索的 PDF，点击「检索 PDF 附件自身的元数据」。已知 DOI 时可直接按 DOI 查询。已识别的题名、作者和年份在 Zotero 原有的列表列显示。
- **生成参考文献表**。选中已识别的附件或将它和普通条目一起多选，右键点击「用所选条目创建参考文献表」。生成时使用各条目自己的书目信息，样式和输出方式在 Zotero 对话框中选择。

## 数据存放与网络请求

父文献的识别结果保存在 Zotero 的「其他」字段。附件的独立书目信息保存在本机插件设置中，分类标签直接加到相应附件。通过 PDF 自动检索时会向 Zotero 识别服务发送提取的识别数据。按 DOI 或来源网页补全时会访问相应的元数据服务或出版商。

## 开发

需要 Node.js 20 或更新版本、npm 和 Python 3。

```sh
npm ci
npm test
npm run build
```

构建会在源码目录生成 `corresponding-author-pro-<version>.xpi`。自动测试涵盖识别逻辑、附件独立归类、列表字段、引用入口和 XPI 结构。界面验收可在 Zotero 选择一篇父文献及两份不同的参考 PDF，依次核对独立检索、分类、仅附件引用和混合引用。

版本变化见 [CHANGELOG.md](CHANGELOG.md)。反馈可提交到 [Issues](https://github.com/xsk23/zotero-corresponding-author-column/issues)，请注明 Zotero 和插件版本，并尽量用可公开共享的文献复现。
