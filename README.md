# dsh-ssh-gateway

[English](./README_EN.md) · 简体中文

让本机 DeepSeek Harness 会话通过系统 OpenSSH，在远程 Linux 项目中读取和修改文件、执行非交互 Bash。Harness、模型凭据、会话历史、技能、记忆和其他插件都留在本机；远端不需要安装 DSH，也不需要模型 API Key。

> 当前版本：0.3.2。要求 Node.js 22.19+、DSH 0.2.1-rc.3+，以及本机可用的 `ssh` 命令。

## 功能

- 在侧栏或设置中管理多个 SSH 目标和远程项目目录。
- 为指定本机会话注册 `remote_exec` 与 `remote_files`，不改变原有本机工具的含义。
- 支持 SSH config、私钥路径、端口和 `ProxyJump`；默认开启严格主机密钥检查、BatchMode，并关闭 agent forwarding。
- 远程文件支持读取、写入、编辑、目录列举、glob、grep 和图片读取。
- 文件修改采用 SHA-256 版本保护、同目录原子替换和 create-if-absent，降低并发覆盖风险。
- 命令输出、文件读取、搜索结果和媒体大小均有限额；取消或超时会终止插件拥有的 SSH 子进程。
- 子 agent 可继承父会话的 SSH 绑定；解绑、断开或卸载会释放作用域工具和资源。
- 可选的 Better Sidebar SSH 适配版提供远程目录树、文本/图片/PDF/HTML 预览。

## 安装

从 GitHub 的默认分支安装：

```sh
dsh plugin --profile web add github:jianghao0799/dsh-ssh-gateway
```

也可以克隆仓库后，在 DSH 插件管理器中安装本地目录：

```sh
git clone https://github.com/jianghao0799/dsh-ssh-gateway.git
```

安装后刷新 DSH Web GUI。如果插件管理器提示 `restart-required`，请完全退出并重新打开 DSH；仅刷新网页不会重启 Host 进程。

## 使用

1. 先在系统终端确认目标可以无交互连接，例如 `ssh my-cluster`。首次连接时应由你在终端中核验并接受主机指纹。
2. 打开 DSH 侧栏或设置中的“SSH 执行工作区”。
3. 填写工作区名称、SSH 别名或 `user@host`、远程项目的 POSIX 绝对路径。端口和私钥路径留空时沿用 SSH config。
4. 点击“连接并检查环境”。远端需要 Linux、Bash 和 Python 3；插件通过 SSH stdin 临时传入 Python 助手，不会在远端持久安装服务。
5. 新建本地会话，或绑定已有本机会话。绑定既有 Bot 会话可以保留该 Bot 的身份、记忆和对话。
6. 在会话中使用 `remote_exec` 和 `remote_files` 操作远程项目。

### 权限模型

远程读取和搜索可在受限会话中使用。远程 Bash、写入和编辑要求 DSH 会话选择 **Full access**，因为插件当前不提供远端 OS 沙箱，不能把本机的 read-only / workspace-write 隔离当成远端隔离。

插件不会自动提升会话权限，不会把失败的命令或写入自动重放，也不会在 SSH 故障时改用本机目录执行。超时或连接中断后，远端结果可能未知；重试有副作用的操作前请先检查实际文件或进程状态。

## 工具

| 工具 | 说明 |
| --- | --- |
| `remote_exec` | 在绑定的远程 Linux 项目中执行非交互 Bash。每次调用都是独立进程，不保留 `cd`、变量或 shell 状态。返回退出码、stdout、stderr、超时和截断信息。 |
| `remote_files` | 远程 `read`、`write`、`edit`、`list`、`glob`、`grep`、`read_image`。相对路径以当前绑定的远程项目根目录为基准。 |

修改已有文件前必须先读取并传回 `version`；新文件使用 `expected_version: "missing"`。文本文件上限 4 MiB，图片上限 10 MiB，其他返回值也有边界。

本机技能中引用的本机脚本路径不能直接交给远程 Bash。需要先读取脚本文本并明确写到远端，或在远端安装对应工具和依赖。

## 状态与凭据

运行状态保存在 DSH home 下的 `ssh-workspaces/state.json`。它只记录 SSH 目标、远程路径、本地 workspace anchor 和会话绑定；插件不保存密码、私钥内容或模型凭据。

- 认证由系统 OpenSSH 和用户的 SSH config/agent/私钥处理。
- 插件不支持交互式密码提示。
- 管理 HTTP 路由复用 DSH 的同源认证，并只允许 owner 管理绑定。
- POSIX 上状态文件以 0600 创建；Windows 使用原目录的文件权限。

安全问题请参阅 [SECURITY.md](./SECURITY.md)。

## 可选：远程文件侧栏

`sidebar-adapter/` 是基于 [DSH Better Sidebar 0.28.1](https://github.com/omdsh-dev/DSH-better-sidebar) 的 MIT 许可维护构建，加入了按会话切换的 SSH 文件后端。它不是使用 `remote_exec` / `remote_files` 的必要条件。

当前适配包名仍为 `dsh-better-sidebar`，不能与官方/上游版同时安装。若要使用：

1. 克隆本仓库。
2. 在 DSH 插件管理器中移除已有的 `dsh-better-sidebar`。
3. 安装本仓库的 `sidebar-adapter/` 本地目录。
4. 刷新 GUI；如 Host 提示需要重启，则完全重启 DSH。

适配版当前对远端文件树和预览提供只读支持。侧栏中的保存、上传、重命名、删除、Git 和压缩操作会明确返回不支持；远程修改请使用 `remote_files` / `remote_exec`。HTML 与 SVG 预览使用沙箱，避免远程内容获得 GUI 同源权限。

派生来源和许可证见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) 与 `sidebar-adapter/LICENSE`。

## 开发与验证

```sh
npm run build
npm run check
npm test
npm run test:python
npm pack --dry-run
```

Windows 上会跳过依赖 Linux Bash/进程组或符号链接权限的少量测试。其余测试覆盖：配置持久化与敏感字段排除、SSH 参数白名单、文件版本保护、远程协议隔离、权限拒绝、取消与超时、会话继承、原子持久化、HTTP 认证、远程侧栏读取和插件资源释放。

真实 SSH 验收不会在 CI 中运行。请使用你有权访问的测试目标：

```sh
# PowerShell
$env:SSH_TARGET = "my-cluster"
$env:SSH_REMOTE_PATH = "/home/me/project"
node scripts/probe-ssh.mjs
node scripts/verify-ssh.mjs
```

可选变量：`SSH_PYTHON`、`SSH_PORT`、`SSH_IDENTITY_FILE`。`verify-ssh.mjs` 会在远端 `/tmp` 创建自己的临时目录，执行写入/读取/编辑/搜索/超时/取消测试，并在结束时清理该目录。

## 已知限制

- 仅支持远程 Linux、Bash、Python 3 和系统 OpenSSH。
- 不提供交互 PTY、SSHFS 挂载或远端 OS 沙箱。
- 每次操作建立独立 SSH 短连接，不保留 shell 会话状态。
- 第三方插件若直接使用本机 `node:fs` 或本机进程 API，仍会访问本机，需要单独适配远程接口。
- 可选侧栏适配版当前只读，且维护基线固定在 Better Sidebar 0.28.1。

## 许可证

本项目使用 [MIT License](./LICENSE)。可选 Better Sidebar 适配代码保留其 MIT 许可和上游归属。
