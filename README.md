# 出击经验记录 · poi 插件

**出击经验记录**是从 Yahagi 首页的「出击经验」功能独立出来、为 poi 适配的插件。它记录普通出击和演习的逐舰经验与 MVP，也能累计逐舰补给、修理和桶的支出。[原项目 Yahagi](https://github.com/yamatosaki/yahagi-kancolle-browser)

普通出击每场战斗结算后，插件会更新逐舰经验、占比、MVP 次数和舰队经验合计。返港后保留上一趟记录。演习结算也计为一次出击。

## 界面预览

**本次出击**显示海域、舰队、已结算场数和舰队经验合计。表格列出舰娘头像、等级、经验、占比和 MVP 次数。返港后切为「上次出击」。

![本次出击页的舰队经验合计和逐舰经验](https://raw.githubusercontent.com/yamatosaki/poi-plugin-sortie-exp/main/docs/images/sortie.png)

**总累计 → 经验**显示累计出击场数、全部舰船经验合计和逐舰 MVP。每页最多显示 10 艘，可以翻页查看，也可以通过「自定义显示」筛选舰娘。旧记录中的「—」表示没有可用的 MVP 数据。

![总累计页的出击场数和逐舰累计经验](https://raw.githubusercontent.com/yamatosaki/poi-plugin-sortie-exp/main/docs/images/totals.png)

**总累计 → 消耗**汇总燃料、弹药、钢材、铝土和桶，支持按任一项排序。点击舰娘行可查看补给、入渠与加速支出及待补给明细。

![资源消耗、五项支出和逐舰账单入口](https://raw.githubusercontent.com/yamatosaki/poi-plugin-sortie-exp/main/docs/images/resources.png)

## 安装

在 poi 的「设置 → 插件」中找到「直接从 npm 服务器安装」，输入 `poi-plugin-sortie-exp` 并点击「安装」。安装后打开「出击经验记录」。也可以下载 `.tgz` 安装包，在同一页面从文件安装。[GitHub Releases](https://github.com/yamatosaki/poi-plugin-sortie-exp/releases) · [poi 插件安装入口](https://github.com/poooi/poi/blob/master/i18n/setting/zh-CN.json#L917-L923)

已在 Windows 上的 poi 12.0.1 验证。

## 使用说明

- **总累计默认关闭。** 开启后，插件统计开关开启期间结算的经验与 MVP。普通出击在返港时入账，演习在结算时入账。补给和修理支出以实际确认的操作入账，待补给金额单独显示。
- **记录按账号保存在本机。** 换号后进入母港，插件会加载该账号的上一趟记录、总累计、累计开关和显示设置。
- **可自定义总累计显示的舰娘。** 在「自定义显示」中搜索和勾选舰娘，点击「完成」后应用。隐藏的舰娘仍会累计经验，顶部合计和占比仍按全部舰娘计算。
- **总累计每页最多显示 10 艘。** 使用表格底部的「上一页」「下一页」翻页。确认新的显示名单或切换账号后回到第一页。
- **自动清理已失去的舰娘。** 游戏确认解体或近代化改修素材消耗后，插件会移除对应舰娘的累计经验、MVP 和资源支出，并按剩余全部舰娘重新计算占比。进入母港时，也会根据完整名簿清理失效记录。
- **清零只作用于当前账号。** 在弹窗中确认后，插件会清除总累计场数、经验、MVP 和资源支出，也会清掉本趟尚未入账的累计数据。
- **逐舰经验上限为 9,999,999。** 刚好达到上限时保留，超过时该舰的对应经验归零，从下一场战斗重新累计。

## 本地开发

可将项目放到 poi 的 `plugins-extra/node_modules/poi-plugin-sortie-exp` 目录，重启 poi 后加载。

```powershell
npm test
npm pack --dry-run
npm pack
```

项目采用 [MIT 许可证](LICENSE)。
