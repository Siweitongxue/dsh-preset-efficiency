# 安装指南（给 DSH 执行）

> 这份文档是给**另一台电脑上的 DSH** 看的：照着从上到下执行，每步失败就停下报错，不要自己猜。
> 目标：把 `planner`（规划者）和 `efficiency`（效率模式）两个预设装进本机 profile。

---

## 0. 前提

| 项 | 要求 |
|---|---|
| DeepSeek Harness | 已安装，能正常启动 |
| git | 任意 2.20+ |
| Node.js | 18+（DSH 自带的即可） |
| 平台 | Windows / macOS / Linux 都可以，路径按下面对应改 |

先确认能拿到仓库：

```bash
git ls-remote https://github.com/Siweitongxue/dsh-preset-efficiency.git
```

- 有输出 → 公开仓库，继续。
- 报 `Repository not found` → 仓库是私有的。改用 SSH（需要对方有权限）：
  `git@github.com:Siweitongxue/dsh-preset-efficiency.git`

---

## 1. 找到 profile 目录

DSH 的 profile 在用户目录下：

```
Windows   C:\Users\<你>\.dsh\profiles\<profile名>
macOS     ~/.dsh/profiles/<profile名>
Linux     ~/.dsh/profiles/<profile名>
```

`<profile名>` 通常是 `desktop`（桌面端）。不确定就列一下：

```powershell
Get-ChildItem "$env:USERPROFILE\.dsh\profiles" -Directory | Select-Object Name
```

```bash
ls ~/.dsh/profiles
```

里面有 `package.json` 的那个就是。

---

## 2. 拉代码

```bash
git clone https://github.com/Siweitongxue/dsh-preset-efficiency.git ~/dsh-presets
```

Windows PowerShell：

```powershell
git clone https://github.com/Siweitongxue/dsh-preset-efficiency.git "$env:USERPROFILE\dsh-presets"
```

产物结构（两个预设都在里面）：

```
dsh-presets/
├── README.md          总览
├── INSTALL.md         本文件
└── presets/
    ├── planner/       规划者
    └── efficiency/    效率模式
```

---

## 3. 改 profile 的 package.json

在 profile 目录里，把两个包加进 `dependencies`，并把它们加进 `dsh.profile.bundles`。

**注意顺序**：`efficiency` 要在 `planner` 前面（planner 用它当工人预设）。

目标文件（`<profile>/package.json`）改完长这样：

```json
{
  "name": "dsh-profile-desktop",
  "private": true,
  "dependencies": {
    "dsh-preset-efficiency": "file:/home/<你>/dsh-presets/presets/efficiency",
    "dsh-preset-planner": "file:/home/<你>/dsh-presets/presets/planner"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-preset-efficiency",
        "dsh-preset-planner"
      ]
    }
  }
}
```

**只保留你原本就有的 bundles 行，追加这两行**，不要删掉原来的。

**用 `file:`，不要用 `link:`。** `link:` 是 pnpm 的私有协议，`npm install` 会直接报
`EUNSUPPORTEDPROTOCOL`；`file:` 两边都认。

后面写**绝对路径**，指向 `presets/<包名>` 这一层。Windows 用正斜杠：

```json
"dsh-preset-efficiency": "file:D:/dsh-presets/presets/efficiency"
"dsh-preset-planner":    "file:D:/dsh-presets/presets/planner"
```

指向 `presets/efficiency` 这一层，不是仓库根目录。

---

## 4. 装依赖

```bash
cd <profile目录>
npm install        # 或 pnpm install，两个都能跑（因为用的是 file:）
```

这一步会在 `<profile>/node_modules` 下建两个 junction/symlink，指向你 clone 下来的目录。

---

## 5. 重启 DSH

预设是启动时组装的，**必须重启**（关掉应用再开）。

重启后：

- 规划者会出现为一个可选预设（默认预设若已配置则直接生效）
- 效率模式同样可选

---

## 6. 验收（不启动 Harness 也能跑）

```bash
cd ~/dsh-presets/presets/planner
python scripts/validate.py          # 期望：OK — bundle patch valid: preset 'planner', 22 插件行
node scripts/test-gate.mjs          # 期望：OK — 35 passed, 0 failed
node scripts/test-skill-gate.mjs    # 期望：OK — 40 passed, 0 failed（技能提案闸门）

cd ~/dsh-presets/presets/efficiency
python scripts/validate.py          # 期望：OK — bundle patch valid: preset 'efficiency', 19 top-level plugin rows
node scripts/test-guard.mjs         # 期望：OK — 15 passed, 0 failed
node scripts/test-modes.mjs         # 期望：OK — 96 passed / 0 failed（模式机制 + dispatch_mode）
node scripts/check-tool-schemas.mjs # 期望：OK — 1 checked / 0 problems
```

需要 `pyyaml`：

```bash
python -m pip install pyyaml
```

全绿 = 装好了。参考输出：

```
planner    : OK — bundle patch valid: preset 'planner', 21 插件行       / 35 passed, 0 failed
efficiency : OK — bundle patch valid: preset 'efficiency', 19 rows      / 15 passed, 0 failed
```

---

## 7. 故障排查

| 现象 | 原因 | 改法 |
|---|---|---|
| 重启后看不到预设 | `bundles` 里没加，或加了但重启前进程没退出 | 检查 `dsh.profile.bundles`，彻底退出应用再开 |
| 启动报 `Cannot find module 'dsh-preset-planner'` | `npm install` 没跑，或 `file:` 路径写错 | 重跑 install；确认路径指向 `presets/planner` 这一层 |
| `file:` 路径带空格出错 | JSON 里没写全 | 用正斜杠写完整路径，例如 `D:/dsh presets/...` |
| `npm install` 报 `EUNSUPPORTEDPROTOCOL` / `Unsupported URL Type "link:"` | 用了 pnpm 的 `link:` 协议 | 改成 `file:`（绝对路径） |
| `validate.py` 报 `ModuleNotFoundError: yaml` | 缺 PyYAML | `python -m pip install pyyaml` |
| 规划者能选，但派工被拒 | 没走完两道门（理解文档 → 确认 → 计划 → 确认） | 这是设计，不是 bug |
| 往 `modes/` 里加了目录，但 `dispatch_mode` 里看不到新模式 | 模式在启动加载时注册，v1 不热加载 | 彻底退出应用再开（改 `skill` 文件不用重启，`watch` 会捡到） |
| 工人调 `skill_proposal` 报「多传了字段」 | 提案闸门的入参表是 `additionalProperties: false`，确认只认用户点按钮 | 别在参数里塞 `confirmed` / `approved`，那是设计上要报错的 |

---

## 8. 卸载

从 profile 的 `package.json` 里删掉那两行 `dependencies` 和两行 `bundles`，然后：

```bash
cd <profile目录> && npm install
```

重启应用即可。clone 下来的目录可以留着，也可以删。

---

## 附：只装一个

- **只要效率模式**：只加 `dsh-preset-efficiency` 一行，`bundles` 也只加一行。
- **要规划者**：两个都得装——规划者派工时会用 `efficiency` 当工人预设。
