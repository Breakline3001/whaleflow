# 第三方软件与许可

WhaleFlow 为独立实现，与 LibTV / Liblib 无隶属或背书关系；应用不包含其业务源代码、标识、媒体、后端或模型凭据。公开脚本仅用于只读研究，未移植到产品，见[研究摘要](<research/LibTV-REA-findings.md>)。

## 当前原生交付

| 组件 | 许可 / 分发说明 | 上游 |
| --- | --- | --- |
| React / React DOM | MIT | [React](https://github.com/facebook/react) |
| React Flow / @xyflow/react / @xyflow/system | MIT；保留画布中的 React Flow attribution 链接 | [XYFlow](https://github.com/xyflow/xyflow) |
| Lucide React | ISC，包含 MIT 的 Feather 部分 | [Lucide](https://github.com/lucide-icons/lucide) |
| Node.js 24.19.0（随包执行进程） | Node.js 为 MIT，所含第三方组件各保留原许可；完整原文随包置于 [host/NODE-LICENSE.txt](<host/NODE-LICENSE.txt>) | [Node.js](https://nodejs.org/) |
| Microsoft WebView2 .NET SDK 1.0.4258.31 | Microsoft 版权的 BSD-style 三条式许可；随包 SDK DLL / loader 对应原文为 [WEBVIEW2-SDK-LICENSE.txt](<WEBVIEW2-SDK-LICENSE.txt>) | [WebView2](https://learn.microsoft.com/microsoft-edge/webview2/) |
| .NET Framework 4.8 / 系统 WebView2 Runtime | 目标 Windows 的系统前提；由 Microsoft 提供和维护，分别适用其产品条款；不能把 SDK 的 BSD-style 许可外推到系统 Runtime | [Microsoft .NET](https://dotnet.microsoft.com/download/dotnet-framework/net48) / [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) |

完整 JavaScript 依赖许可原文收录于 [third-party-licenses](<third-party-licenses/>)，版本与文件对应关系见 [INDEX.json](<third-party-licenses/INDEX.json>)。本摘要不替代原始版权、条件和免责声明。

WebView2 SDK 允许按原许可条件以源码或二进制形式再分发：必须保留版权、条件及免责声明，不得未经允许使用 Microsoft 或贡献者名称为衍生产品背书。随包保留完整原文，不仅保留本段说明。

默认产品使用 WinForms / .NET Framework 4.8 + **系统 WebView2 Runtime**，不随包分发 Electron 或整套 Chromium Runtime；这不代表系统 WebView2 不使用 Chromium，也不改变其适用条款。用户无需单独安装 Node.js。

## 仅源码中的实验 / 构建依赖

Electron 44.9.0 与 electron-builder 仅保留用于未验收的 legacy 实验路径，**不是当前生产运行时**。若自行构建 Electron 实验包，仍须分发 Electron MIT 原文及其 Chromium/其他组件完整声明；不能把当前原生包的许可清单当作该实验包全部许可。

Vite、esbuild、@vitejs/plugin-react 等为构建工具。确切锁定版本见 [package-lock.json](<package-lock.json>)；构建工具和传递依赖的原许可不被本摘要替换。项目自身许可见 [LICENSE](<LICENSE>)。
