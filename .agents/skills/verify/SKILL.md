---
name: verify
description: 验证本项目的实现和验证流程变更，按 diff 选择单元、离线进程、Ego Lite 浏览器或真实模型检查，交付可复跑的通过与失败证据。
---

# 验证项目变更

改动前从 [业务验收目标](../../../docs/product-behavior.md) 选出受影响场景，写下输入、预期和判断依据。流程变更以已批准的流程预期为准。复用能覆盖预期的现有测试。

| diff 触及范围 | 检查 |
|---|---|
| 纯规则、日期和输入解析 | 固定输入、时钟和时区，检查正常返回、边界和拒绝路径。 |
| 持久化、重试或确认 | 用真实 HTTP、Durable 和 SQLite 比较操作前后的状态。按影响检查旧数据恢复、同一请求重试或确认前后的状态。 |
| 页面或用户路径 | [使用 Ego Lite 操作实际页面](../../../verification/durable-mvp/README.md#可复跑的浏览器验收)，再用 HTTP 状态、日志或程序断言核对业务事实。 |
| 影响真实对话的提示词、模型接入、自然语言意图或参数映射、工具选择或组合，以及确认后的对话行为 | 在本地运行有界真实模型验证：`npm run check:real` 及[真实模型浏览器验收](../../../verification/durable-mvp/README.md#真实模型浏览器验收)中的受影响场景（使用全新临时 `--data` 目录）。 |
| 验证规则或脚本 | 按下方「验证规则变更」执行。 |

先跑针对性检查，再运行 `npm run check`。失败时先定位原因，修复后重跑失败项和受影响场景。保留失败输出，避免用反复重试掩盖不稳定检查。

`npm run check` 和默认 CI 使用离线模型；按用户常驻授权，触及真实对话、模型、工具或环境加载的改动应在本地补跑有界 `npm run check:real`（及受影响浏览器场景），仅在缺少 `.env`/密钥或网络环境时标明阻塞原因与待补验收项。

## 验证规则变更

同一变更若调整检查脚本、断言或覆盖范围，交付时说明判定标准的变化，以已确认的业务规则或基线预期验证正确场景能通过、已知错误会失败。

## 单元测试模板

正式回归测试使用 Node 原生 `node:test`（位于 `tests/*.test.ts` 与 `verification/durable-mvp/*.test.ts`），由 `scripts/check.ts` 发现执行；进程与纯函数写法可参考 `verification/durable-mvp/current-time.test.ts`。每个用例写明**规则来源、固定输入、实际调用和预期**。直接写出期望值，按规则选正常、边界和拒绝用例。拒绝输入涉及写入时，再用进程测试断言状态未变。

以下是 `CONTEXT.md` 中「日程重叠」的一次性演示，可在仓库根目录通过 `node --input-type=module` 从标准输入运行。该 `node:test` 示例用于演示断言与反例验证，不属于 `scripts/check.ts` 的检查流程。

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inRange } from './durable_mvp/calendar.ts';

const start = '2030-06-15T15:00:00+08:00';
const end = '2030-06-15T16:00:00+08:00';
const events = [{ id: 'review', start, end }];

test('相交一分钟返回该日程', () => {
  const result = inRange(events, '2030-06-15T15:59:00+08:00',
    '2030-06-15T17:00:00+08:00');
  assert.deepEqual(result.map(event => event.id), ['review']);
});

test('首尾相接不重叠', () => {
  const result = inRange(events, end, '2030-06-15T17:00:00+08:00');
  assert.deepEqual(result, []);
});

test('拒绝零长度区间', () => {
  assert.throws(() => inRange(events, start, start), /结束时间必须晚于开始时间/);
});
```

验证模板时，在临时副本中把「首尾相接」的预期改为 `events`，确认仅该用例失败、其余两个用例通过且命令返回非零，再用原预期复跑并确认三个用例全部通过。交付时报告每轮通过和失败数及失败用例名称。

按 [交付证据模板](../../../verification/durable-mvp/README.md#交付证据模板) 报告最终改动对应的验证结果。用 `AGENTS.md` 的标准判断是否可以报告 Agent 验收通过。
