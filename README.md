# UFI-TOOLS Mihomo Enhanced（mihomo 内核插件 · 强化版）

[By_Jace](https://github.com/xyjace) 出品 ｜ 适用于 [UFI-TOOLS](https://github.com/kanoqwq/UFI-TOOLS)（中兴随身WiFi F50 / U30 Air 等紫光展锐 Android 设备）

在 UFI-TOOLS 后台内一键部署 mihomo（ClashMeta 内核）透明代理，热点设备直接翻墙，无需订阅管理器、无需命令行。

## 特性

- **官方内核**：MetaCubeX/mihomo 官方 android-arm64 构建（非第三方打包），内置「升级内核」按钮自动追新（多镜像轮询 + sha256 校验）
- **安全加固**（相对社区常见打包方式）：
  - 控制面密钥**安装时随机生成**（32 位 hex），不留默认口令
  - CORS 全关（热点侧任意网页无法跨域控制内核/读取配置）
  - 权限收紧：服务脚本 700、配置 600（拒绝"全目录 777 + root 跑脚本"的提权面）
- **双通道节点导入**：
  - 「导入节点」：本地节点文件直达设备（yaml 节点表 / `vless://` `ss://` 分享链接文本均支持），凭据不经过任何第三方
  - 「订阅管理」：支持机场订阅链接（http provider，多 UA 容错）
- **自愈与升级**：重置配置（拉取最新模板，自动保留密钥与节点）、停止等待进程退出 + iptables 残留清理、开机自启、紧急开关（touch disable）
- **ZashBoard 面板内嵌**：展开即自动连接（URL 带密钥免输）

## 安装

1. 依赖：UFI-TOOLS ≥ 3.9.0，开启「高级功能」
2. 把 Release 里的插件 JS 全文粘贴进 UFI-TOOLS「插件管理」→ 添加插件
3. 展开插件面板 → 点「安装」→ 自动下载依赖包（GitHub 直连/镜像/备用源轮询，sha256 校验）
4. 点「导入节点」（本地节点文件）或「订阅管理」（订阅链接）
5. 展开 ZashBoard 面板即自动连接

详见 [INSTALL.md](INSTALL.md)。与已安装的"猫猫Clash"插件互斥（两者使用相同 TUN 设备），安装前会自动检测。

## 与原版猫猫插件的关系

本项目的服务脚本与配置模板基于 kanoqwq 的 [猫猫Clash(Mihomo)插件 2.4](https://github.com/kanoqwq/UFI-TOOLS-PLUGINS) 修改强化，TUN+FORWARD 透明代理架构沿用其经实机验证的方案——感谢 MiniKano 的开源工作。差异集中在：官方内核直连升级、安全加固、节点文件导入、页面化订阅管理。

## 安全建议（所有 UFI 用户）

无论用哪个代理插件，建议检查两点：控制面密钥是否为默认值、`/data` 下插件目录权限是否 777。这两点在热点可达范围内都是真实攻击面。

## License

MIT — 见 [LICENSE](LICENSE)。请保留原作者署名。
