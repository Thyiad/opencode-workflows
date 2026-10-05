# opencode-workflows

让 opencode 无人值守地完成「完善 plan → 按 plan 实现 → 审查 → 验收 → 提交」的一组命令。装成全局命令后，在任何接入了这套流程的仓库里都能用：命令总是作用于**当前目录所在的 git 仓库**。

| 命令 | 做什么 |
|---|---|
| `refine-plan` | 让 opencode 的 `/refine-plan` 自动评审、修改一份 plan，守住改动范围和轮次，生成修改记录 `refine-report.md`，发邮件 |
| `run-milestones` | 按编号逐个跑 `specs/NN-*/plan.md`：opencode 实现 → 独立审查 → 自己再跑一遍验收命令 → 提交 |
| `run-milestones-auto` | 包一层 `run-milestones`：跑完发邮件，失败时先让 Claude Code 无人值守地分析修复 |
| `run-gated-stages` | 按流水线文件分阶段跑 `run-milestones-auto`，阶段之间做安全评审和收尾检查 |
| `opencode-workflows-mail` | 发一封测试邮件，确认邮件通知配好了 |

每个命令都有 `--help`；完整的行为说明在 `src/` 下各文件开头的注释里。

## 安装成全局命令

需要 Node.js 22 或更高，以及 git、[opencode](https://opencode.ai) v2（2.0.18 或更高）。`run-milestones-auto` 和 `run-gated-stages` 失败修复与安全评审还需要 Claude Code（2.1.259 或更高，已登录）。

```bash
git clone git@gitee.com:Thyiad/opencode-workflows.git
cd opencode-workflows
npm link
```

`npm link` 把上面五个命令链接到 npm 的全局 bin 目录（就是 `npm prefix -g` 下的 `bin`），指向这个目录里的文件。确认装好了：

```bash
refine-plan --help
```

- **更新**：在这个目录里 `git pull` 即可，全局命令是指向这里的链接，不用重新安装。
- **用 nvm 的话**：全局 bin 目录跟着 Node 版本走，切换到另一个 Node 版本后要在这个目录里再执行一次 `npm link`。
- **卸载**：`npm rm -g opencode-workflows`。
- **Windows**：同样执行 `npm link`，npm 会生成 `.cmd` 包装，命令名一样。

这个包没有任何依赖，不需要 `npm install`。

## 让一个仓库接入

1. **opencode 的命令和 agent**：把 [`examples/.opencode/`](examples/.opencode/) 整个复制到仓库根目录：

   | 文件 | 用途 |
   |---|---|
   | `commands/implement-plan.md`，`agents/implementer.md`、`reviewer.md`、`reviewer-fallback.md` | `/implement-plan` 和 `run-milestones`：DeepSeek 实现，GPT 只读审查，GPT 不可用时换 Claude |
   | `commands/refine-plan.md`，`agents/plan-editor.md`、`plan-reviewer.md`、`plan-reviewer-fallback.md` | `/refine-plan` 和 `refine-plan`：评审、修改 plan |
   | `workflows.json` | 仓库设置，见下一条 |

   然后按仓库的情况改，主要是三处：agent 的 `permissions`（这个仓库的测试、类型检查、lint 命令怎么写，哪些脚本绝不能跑，例如部署、发布）；agent 正文里的「必读文档」（仓库的约定文件、设计文档）；`model`（换模型只改这一行）。每对 `*-fallback.md` 要和主 agent 保持一致，只有 `description` 和 `model` 不同。OPOC-DSH 和 OPOC 两个仓库是改好的实例。
2. **仓库设置** `.opencode/workflows.json`（可选，opencode 会忽略它），示例见 [`examples/.opencode/workflows.json`](examples/.opencode/workflows.json)：

   | 字段 | 含义 | 默认 |
   |---|---|---|
   | `name` | 邮件标题里的标签、发件人名称 | 仓库目录名 |
   | `requiredEnv` | 跑里程碑前必须设置的环境变量：`{ "变量名": "说明" }` | 无 |
   | `protectedDocs` | 无人值守的 Claude 修复和安全评审不许改的文档（另外总是保护 `specs/**/plan.md`、`specs/00-conventions.md`） | 无 |
   | `machineNotes` | 告诉无人值守的 Claude 的本机情况（已知的环境问题和处理办法） | 无 |
   | `pipelinesDir` | `run-gated-stages` 找流水线文件的目录 | `scripts/pipelines` |

3. **规格目录**：`specs/00-conventions.md` 写所有规格共用的约定；每个规格一个目录 `specs/NN-<名字>/`，`NN` 至少两位、递增（`01`…`99`，之后 `100`…），里面是 `plan.md`。`plan.md` 的第一个 `# ` 标题是名称（`# M12：…`），必须有一节 `## 验收命令`，里面一个 ```` ```bash ```` 代码块，每行一条完整的命令。实现通过后 implementer 写入 `STATUS`（`APPROVED`），`run-milestones` 据此判断完成。
4. **`.gitignore`** 加上运行记录目录：

   ```gitignore
   .milestone-logs/
   .plan-refine-logs/
   ```

## 用法

在仓库里（任意子目录都行）：

```bash
refine-plan specs/35-foo --dry-run           # 看范围、模型和验收命令检查
refine-plan specs/35-foo --max-rounds 3      # 无人值守地完善 plan
refine-plan ../OPOC/specs/01-foo             # 别的仓库里的 plan：在那个仓库里用它自己的 .opencode 跑

run-milestones --dry-run                     # 列出各里程碑的状态
run-milestones-auto --only 35                # 实现 M35，失败时 Claude 修复，结束发邮件
run-milestones-auto --from 35 --to 37
run-gated-stages --pipeline oauth --dry-run
```

在 opencode 的交互界面里，同样的流程是 `/refine-plan specs/35-foo 3` 和 `/implement-plan specs/35-foo`。

### refine-plan

plan-editor（DeepSeek）调用只读的 plan-reviewer（GPT）评审 plan，按意见修改，循环到通过或达到轮次上限。涉及用户设计决定的问题不改，标成「需人工决定」。默认只改 `plan.md`，其他文档用 `--also` 指明（只能是 `specs/` 或 `docs/` 下的）。

收尾检查（无人值守和交互两种入口都做）：改动只限范围内的文档、每轮评审前都用 `--check` 记录了文档版本、通过的正是当前内容、轮次没有超限、验收命令能解析。结果写进规格目录的 `refine-report.md`；过程记录在 `.plan-refine-logs/`。不提交。退出码：0 通过，3 达到上限仍有问题，1 运行失败。

### run-milestones 与跨仓库占位

`run-milestones` 只认带编号的目录。一个仓库要按自己的编号顺序去跑另一个仓库里的规格时，放一个占位 `plan.md`：

```markdown
# M25：……
<!-- milestone-repo: ../OPOC -->
<!-- milestone-spec: specs/01-foo -->
```

驱动脚本到 M25 时切到 `../OPOC`，用那边的 `.opencode` 实现那份规格，在那边提交；那个仓库 `workflows.json` 的 `requiredEnv` 也要满足。现在也可以直接在那个仓库里运行 `run-milestones`，不再需要占位。

## 邮件通知

配置放在所有仓库之外：`~/.opencode-workflows/notify.env`（Windows：`%USERPROFILE%\.opencode-workflows\notify.env`；旧位置 `~/.qiwi-milestones/notify.env` 在新文件不存在时也会读）。没有这个文件时一切照常，只是不发邮件。一行一个 `KEY=VALUE`：

```ini
SMTP_USER=<QQ 号>@qq.com
SMTP_PASS=<授权码>
# 可选：收件人，默认同 SMTP_USER，多个用逗号分隔
MAIL_TO=<收件地址>
# 可选
SMTP_HOST=smtp.qq.com
SMTP_PORT=465
MAIL_FROM_NAME=opencode-workflows
```

`SMTP_PASS` 是 QQ 邮箱的授权码，不是 QQ 密码：QQ 邮箱网页版 → 设置 → 账户 → POP3/IMAP/SMTP/Exchange/CardDAV 服务 → 开启「POP3/SMTP 服务」→ 按提示生成。配好后：

```bash
opencode-workflows-mail --test
```

配置只交给发信模块，不进环境变量，opencode 和 Claude 都读不到。

## 开发

```bash
npm test
```

测试不访问网络，不发邮件，不需要 opencode：涉及 opencode 的流程用一个假的 opencode 跑。以后要发布到 npm，把 `package.json` 里的 `"private": true` 去掉、确认包名，然后 `npm publish`；安装方式变成 `npm install -g opencode-workflows`，用法不变。
