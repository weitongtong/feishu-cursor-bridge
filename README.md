# feishu-cursor-bridge

通过飞书机器人对接 Cursor CLI，在飞书里远程协作编码任务。

## 架构

```text
飞书用户 → 飞书服务器 → [长连接] → 本地 Node.js 服务 → Cursor CLI → 回复到飞书
```

- 使用飞书长连接（WebSocket）接收消息，无需公网 IP 或域名
- 通过 `agent` CLI 非交互调用 Cursor
- 支持 `ask` / `plan` / `run` / `cloud` 四类任务模式

## 核心交互流程

```text
发送文本 → 暂存需求描述，可多次补充
/plan → Cursor 以只读模式分析代码并生成方案
/agent → Cursor 以 agent 模式执行方案（允许改文件）
```

1. 发送任务描述，可多次补充细节
2. 发 `/plan` 让 Cursor 规划方案
3. 方案满意后，发送 `/agent` 让 Cursor 执行

## 前置条件

1. 本地已安装 Cursor CLI，可运行 `agent --version`
2. 已通过 `agent login` 登录 Cursor，或设置 `CURSOR_API_KEY`
3. 已在 [飞书开放平台](https://open.feishu.cn) 创建应用，并开启：
   - 机器人能力
   - 权限：`im:message`、`im:message:send_as_bot`
   - 事件订阅：`im.message.receive_v1`

## 快速开始

```bash
npm install
cp .env.example .env

# 开发模式
npm run dev

# 或编译后运行
npm run build
npm start
```

## 命令说明

### 核心命令

| 输入            | 说明                                                       |
| --------------- | ---------------------------------------------------------- |
| 直接发送文本      | 暂存需求描述，可多次补充                                   |
| `/plan [指示]`    | 开始规划（合并已暂存内容），只读不改文件                   |
| `/agent [指示]`   | 开始执行并允许改文件；不带参数则执行之前讨论的方案         |
| `/ask [问题]`     | 只读问答，不改任何文件                                     |
| `/cloud [任务]` | 提交到 Cloud Agent                                         |

### 辅助命令

| 命令            | 说明                       |
| --------------- | -------------------------- |
| `/new`          | 清除会话，重新开始         |
| `/cancel`       | 取消正在执行的任务         |
| `/ws`           | 查看可用工作区             |
| `/ws <别名>`    | 切换到预设工作区           |
| `/model <名称>` | 切换模型                   |
| `/status`       | 查看当前会话状态           |
| `/help`         | 显示帮助                   |

## 工作区

推荐使用工作区别名，而不是每次手输路径。

在项目根目录创建 `workspaces.json`：

```json
{
  "demo": "~/home/temp/test/demo",
  "myapp": "~/projects/myapp"
}
```

然后在飞书里发送：

```text
@机器人 /ws
@机器人 /ws demo
```

切换工作区时会自动清空当前 Cursor 会话，避免把旧上下文带进新项目。

## 运行中消息处理

当 Cursor 正在执行任务时，你继续发送的消息会自动排队：

- 收到提示"你的消息已记录"
- 当前任务完成后，排队消息会合并为一条，以 plan 模式继续
- 如果需要立即停止当前任务，发送 `/cancel`

## 环境变量

| 变量               | 必填 | 说明                                    |
| ------------------ | ---- | --------------------------------------- |
| `FEISHU_APP_ID`    | 是   | 飞书应用 App ID                         |
| `FEISHU_APP_SECRET`| 是   | 飞书应用 App Secret                     |
| `CURSOR_API_KEY`   | 否   | Cursor API Key，已 `agent login` 可省略 |
| `DEFAULT_WORK_DIR` | 否   | 初始工作目录，默认当前目录              |
| `DEFAULT_MODEL`    | 否   | 默认模型名称                            |
| `CURSOR_TIMEOUT_MS`| 否   | 执行超时，默认 `300000`                 |
| `CURSOR_BIN`       | 否   | Cursor CLI 可执行文件名，默认 `agent`   |
