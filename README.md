# opencode-workflows

让 opencode 无人值守地完成「完善 plan → 按 plan 实现 → 审查 → 验收 → 提交」的一组命令。装成全局命令后，在任何接入了这套流程的仓库里都能用：命令总是作用于**当前目录所在的 git 仓库**。

| 命令 | 做什么 |
|---|---|
| `refine-plan` | 让 opencode 的 `/refine-plan` 自动评审、修改一份 plan，守住改动范围和轮次，生成修改记录 `refine-report.md`；需要你处理时先让 Claude Code 处理，再发邮件 |
| `run-milestones` | 按编号逐个跑 `specs/NN-*/plan.md`：opencode 实现 → 独立审查 → 自己再跑一遍验收命令 → 提交 |
| `run-milestones-auto` | 包一层 `run-milestones`：跑完发邮件，失败时先让 Claude Code 无人值守地分析修复 |
| `refine-and-run` | 从初版 plan 到提交的代码：先用 `refine-plan` 评审选中的全部 plan 并提交，全部通过后再 `run-milestones-auto`；有 plan 需要你就不写代码 |
| `run-gated-stages` | 按流水线文件分阶段跑 `run-milestones-auto`，阶段之间做安全评审和收尾检查 |
| `opencode-workflows-mail` | 发一封测试邮件，确认邮件通知配好了 |

每个命令都有 `--help`；完整的行为说明在 `src/` 下各文件开头的注释里。

## 安装成全局命令

需要 Node.js 22 或更高，以及 git、[opencode](https://opencode.ai) v2（2.0.18 或更高）。`refine-plan`、`run-milestones-auto`、`refine-and-run` 的自动处理和 `run-gated-stages` 的安全评审还需要 Claude Code（2.1.259 或更高，已登录；没有时照常运行，只是不自动处理）。

```bash
git clone git@gitee.com:Thyiad/opencode-workflows.git
cd opencode-workflows
npm link
```

`npm link` 把上面六个命令链接到 npm 的全局 bin 目录（就是 `npm prefix -g` 下的 `bin`），指向这个目录里的文件。确认装好了：

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
   | `commitScope` | 里程碑提交使用的 scope，例如 `asset`，生成 `feat(asset): …`；跨仓库提交使用目标仓库自己的配置 | 本仓库用 `MNN`，跨仓库不带 scope |
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

5. **需求文档（可选）**：产品经理给出、已经确认的需求放在 `docs/requirements/<需求名>/`，作为 plan 的输入快照，不随代码更新、也不由开发修改；有变化由产品出新修订，替换旧文件。需求里的条目最好带编号（例如 `FR-` 功能、`BR-` 规则、`OOS-` 不包含项），来自需求的 `plan.md` 在开头写明需求来源、覆盖的编号、与需求的差异。模板里的 agent 已经按这个约定写好：plan 引用了需求，plan-reviewer 就按它声称覆盖的条目查漏和冲突，implementer 和 reviewer 也会读它；plan-editor 不能写 `docs/requirements/**`，示例 `workflows.json` 也把它列进了 `protectedDocs`。**不是每个 plan 都要有需求**，不引用需求的 plan 行为不变；不用这个约定的仓库什么都不用改，放在别的目录就同时改 plan-editor 的那条 `deny` 和 `protectedDocs`。OPOC-DSH 的 `docs/requirements/README.md` 是一个写好的实例（修订规则、状态表、从需求到 plan 的步骤）。

## 用法

在仓库里（任意子目录都行）：

```bash
refine-plan specs/35-foo --dry-run           # 看范围、模型和验收命令检查
refine-plan specs/35-foo --max-rounds 3      # 无人值守地完善 plan
refine-plan specs/35-foo --also docs/BUSINESS-API.md   # 这份文档也允许改
refine-plan --only 35,36 --max-rounds 3      # 按编号批量：逐个评审多个 plan
refine-plan --from 35 --to 37 --dry-run      # 批量看范围
refine-plan ../OPOC/specs/01-foo             # 别的仓库里的 plan：在那个仓库里用它自己的 .opencode 跑

refine-and-run specs/35-foo                  # 评审 M35 的 plan，通过就提交并实现
refine-and-run --only 35,36                  # 先评审 M35、M36 的 plan，都通过后再实现
refine-and-run --from 35 --to 37 --dry-run   # 看每个里程碑要做什么

run-milestones --dry-run                     # 列出各里程碑的状态
run-milestones-auto --only 35                # 实现 M35，失败时 Claude 修复，结束发邮件
run-milestones-auto --from 35 --to 37
run-gated-stages --pipeline oauth --dry-run
```

在 opencode 的交互界面里，同样的流程是 `/refine-plan specs/35-foo 3` 和 `/implement-plan specs/35-foo`。

### refine-plan

plan-editor（DeepSeek）调用只读的 plan-reviewer（GPT）评审 plan，按意见修改，循环到通过或达到轮次上限。涉及用户设计决定的问题不改，标成「需人工决定」。默认只改 `plan.md`，其他文档用 `--also` 指明（只能是 `specs/` 或 `docs/` 下的）。

批量：`--only 35,36`（也支持 `35-37,40` 这样的范围）或 `--from 35 --to 37` 会按编号顺序**逐个**评审本仓库 `specs/` 下的规格，每个规格一次独立的 opencode 会话和一个记录目录，共用一个 `--max-rounds` 和一份 `--also`；已实现（有 `STATUS`）的规格跳过。结束时发一封邮件：评审多个规格时是汇总邮件，只评审一个时和普通运行一样（标题直接是那个 plan）。退出码按最坏的结果取（有失败 1，否则有未解决 3，否则有待决定 4，全通过 0）。批量只用于完整运行，不能和 `--start/--check/--finish` 一起用。

收尾检查（无人值守和交互两种入口都做）：改动只限范围内的文档、每轮评审前都用 `--check` 记录了文档版本、通过的正是当前内容、轮次没有超限、验收命令能解析。结果写进规格目录的 `refine-report.md`；过程记录在 `.plan-refine-logs/`。不提交。

需要你处理时——运行失败、达到轮次上限仍有阻塞问题，或评审通过但有「需人工决定」的问题——先交给 Claude Code（`claude -p`）处理一轮（`--fix-rounds`，默认 1；0 不处理）。Claude 只能改范围内的文档：能从代码、约定和需求文档里找到答案的阻塞问题它直接改，然后**重新评审一遍**（新的 opencode 会话，从第 1 轮开始，所以评审员也会复核 Claude 的修改）；真正要你决定的事它不替你决定，只把每个问题整理成选项和推荐写进邮件。改了范围以外的文件就停下，不再评审。还需要你时发邮件，并在终端里用 Remote Control 打开那个 Claude 会话：电脑上直接接手，或在手机 Claude App → Code 里接手；处理好后按邮件里「处理好后继续」的命令重跑。批量时每个规格各自处理，汇总邮件里列出每个要接管的会话，终端里打开第一个。`--accept-decisions` 让「需人工决定」的问题不再拦住通过（你做完决定、写进 plan 后重跑时用），`--no-handover` 不打开会话。Claude 处理过时，`refine-report.md` 末尾多一节「无人值守 Claude 的处理」，并列出之前各次运行的记录目录。

退出码：0 通过，4 通过但有问题要你决定，3 达到上限仍有阻塞问题，1 运行失败。

### refine-and-run

写完初版 plan 后一条命令跑到底。和其他命令一样，跑一个（`refine-and-run specs/35-foo` 或 `--only 35`）或多个（`--only 35,36`、`--only 35-37,40`、`--from 35 --to 37`）：

1. **先评审全部 plan**：选中的里程碑里还需要评审的，交给一次 `refine-plan --only …` 按编号逐个评审（全部通过时不发邮件）；
2. 评审通过的 plan 逐个提交：`plan.md`、`--also` 的文档和 `refine-report.md`，提交信息 `docs(M35): 完善 plan：…`，跨仓库占位在目标仓库里提交。只提交评审时的版本：评审之后又改过（比如接管会话时）的不提交，下次重新评审；
3. **全部 plan 就绪后才写代码**：用同样的选择跑一次 `run-milestones-auto`，实现、审查、验收、提交并推送。

有 plan 需要你处理时，refine-plan 照常处理（Claude 先处理，再发邮件、打开会话），其余 plan 照常评审、提交，但**一行代码都不写**，终端里打印接着跑的命令。实现失败时同样由 run-milestones-auto 处理。重跑同一条命令就接着做：已实现的跳过；`refine-report.md` 已提交、结论是通过、评审时记下的文档版本和现在一致的（之后改过的，提交了也算改过），不再评审；`STATUS` 已存在的直接交给 `run-milestones-auto`。`--skip-refine` 不评审直接实现。

开始前检查：本仓库或跨仓库的目标仓库在 master/main 上、又没带 `--allow-main` 时直接拒绝，不会先在那里提交 plan；选中的规格目录和 `--also` 的文档以外有未提交的改动时也拒绝（否则评审完才被 `run-milestones` 拒绝），确认属于本次里程碑时加 `--allow-dirty`。plan 提交只包含评审过的文件（评审删掉的文档也一并提交删除），暂存区里别的内容原样留着。有「需人工决定」问题的通过报告，即使你手动提交了，也不算就绪，除非当时或现在带了 `--accept-decisions`。开始写代码前会再检查一遍所有要实现的 plan：本轮的评审改了共用文档、让之前的通过失效时，不写代码，重跑会重新评审。全部已实现但还有没推送的提交时，交给 `run-milestones-auto` 补推送。参数怎么分给两个命令见 `refine-and-run --help`。

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
