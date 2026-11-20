# ADR 003：正式放下差旅并统一至纯 Node/TypeScript

状态：已决定，2026-11-20，落实用户明确决定。

1. **正式放下差旅业务与冻结资产**：移除 `travel_agent/`、`pyproject.toml`、`verification/baseline/`、差旅工具测试、差旅环境变量与 `B01–B12` 业务目标，不再背负差旅待接入包袱。清理前最后包含差旅资产的实际 `main` 提交：`59e79a7`（例如 `git show 59e79a7:travel_agent/real_tools.py` 可查阅历史源码）。
2. **统一运行与检查工具链至纯 Node.js 22.19+ / TypeScript**：移除 Python 启动壳（`travel_agent/__main__.py`）与 Python 检查入口（`scripts/check.py`），将根包配置、`.env` 加载（`durable_mvp/env.ts`）、默认离线检查（`scripts/check.ts`）与 MVP 进程验收（`verification/durable-mvp/*.test.ts`）统一至根目录 `package.json`（包名调整为 `personal-agent`）和 Node 原生 `node --test`。GitHub 仓库改名保留给用户在仓库设置中自行决定。
3. **产品方向演进为 Personal Agent**：当前仍聚焦已确认的个人日程（S01–S05）核心闭环；同时关闭已失真的 9 个历史 Open Issue（`#42`、`#44`、`#46`–`#52`）。

范围边界：本轮仅清理历史包袱并统一单语言工程入口；`durable_mvp/` 内部底座与领域分层、跨会话/长期个人数据解耦以及历史探针 `verification/durable-step0/` 去留，均留待后续架构讨论单独决定，本轮不修改。
