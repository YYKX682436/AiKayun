# ⑦-5A 生产备份（R3 本地代码验收完成；CI 记录见本节；商业发行未通过）

本文记录⑦-5A隔离实现和验收证据，不是客户生产操作手册。正式发行签名链、公开 GHCR 和商业 Linux 主机演练没有通过。不得在客户生产环境运行本工作树命令，也不得用旧的 `scripts/backup-compose-data.sh` 替代发行备份。

## R3 宿主运维与 API 职责（2026-11-06）

Docker/Compose 编排由签名发行包中的宿主 `/opt/aikayun/release/backup-host-broker.sh` 执行。API 镜像只负责 Node 业务/数据库核对和 PG18 custom dump，不含 Bash、Docker CLI、Compose CLI 或 `libtinfo6`；Trust Store 仍使用 `/usr/bin/flock`。生产 Compose 不把 Docker socket 挂给 API 或 Restic reader。客户主机只需安装器原已要求的 Docker Engine、Compose v2、Bash，不需要 Git、Node、pnpm 或源码仓库。Restic reader 是固定 digest 的独立精简镜像，源数据只读，没有 Docker socket，仅本地加密仓库可写；备份密码只读挂载，不进发行 manifest 或日志。

客户入口链为：`sudo /opt/aikayun/aikayun backup create` → 停写前检查 root-owned 固定 launcher、已保存的发行签名证明、manifest、broker 和全部工件 SHA-256 → 获取共享 `/run/lock/aikayun-install.lock` → 宿主 broker 校验部署、Compose、容器、挂载及 PG 目标 → 写现有维护 journal、停止原先运行的写入者并阻止数据库写角色登录 → API 执行 PG18 dump、broker 有界采集业务文件 → 固定 digest 的 Restic reader 加密配对快照 → 解密检查并校验数据库、身份、Pending Key、Trust Store、时间水位、私有文件和快照配对 → 按 journal 恢复原服务和角色 → 校验后发布 `verified`。install/resume/setup-token 与 backup 复用同一把非重入锁，每个入口只获取一次。launcher、broker、manifest 或发行工件被替换、删除、篡改时，会在停服务之前拒绝。

运维脚本和必要 helper 纳入签名 manifest 与 SHA 校验；调用时不从未验证网络或可修改路径运行 helper。临时测试发行真实执行 JWS、工件身份和 SHA-256 检查；Cosign 由隔离测试 wrapper 模拟，使用临时签名根，**不代表生产 Cosign/OIDC 身份、生产信任根或 GHCR 验证**。

## R3 客户命令端到端验收

隔离 AMD64、ARM64 Docker Engine 和真实 PostgreSQL 18 发行 Compose 均从安装后的 `/opt/aikayun/aikayun` 执行完整 `backup create`。临时发行已执行数据库迁移和服务启动；测试 Restic 密码、Trust Store、Pending Key、时间水位及私有文件均为隔离材料。

| 架构 / 当前源状态 | 完整客户命令 verified set | 临时发行 manifest SHA-256 | 结果 |
| --- | --- | --- | --- |
| AMD64，背压修复前的成功路径 | `d03569c9-aadb-41a5-91b3-366e9bbc5ae8` | `09fa12a932aace3bdc002973a82d8cf8ffc89004942f6e9bb5d382dc9614a422` | create、独立 verify、恢复服务通过 |
| ARM64，修复前的成功路径 | `ea21044e-9c0e-424e-a414-6e1828487c72` | `66e5e6ce5e7b2d7c14b10c88ca3335c37eb1d1903bc04260db74dcebc91951bb` | create、独立 verify、恢复服务通过 |
| ARM64，背压关闭修复后的当前 API 与新发行包 | `e51ede9d-836f-4c3d-8bda-24f5bf633190` | `97b9a297b6ab95d2b213695e49259bd241d713cafb7404fc4d44860467b36ebf` | create 和独立 `backup verify` 返回 verified，服务恢复通过 |

修复后 ARM64 客户命令使用的隔离 API 镜像本地引用 digest 为 `sha256:71014f45e29b266a470f299944a94487d19d10497e35d3865b39580697a2330c`，完整归档 SHA-256 为 `b101355a863742e91c37645cbbf058b3dc3ac02fe9e96108afe757a46e9afe16`。没有把它描述成 GHCR 或正式发行 digest。

每个成功集合都包含与数据库 dump 绑定的文件清单，并发布互相配对的两条 Restic 快照。146 项备份前后文件清单中的身份私钥、Pending Key、Trust Store、时间水位、私有文件、部署秘密及目录/模式/owner/SHA 完全一致。AMD64 清单 SHA-256 为 `e3ec81f8ccc44c04637c72e12230c66b3d72b0af53dbe022c3e2570388419151`，ARM64 为 `98cddc84986825f08185f04b936b7c477bed7cb2f712ed3a9fad70be4bc5e5cd`。独立验证后，服务恢复到备份前运行状态，journal 为 `restoration_recorded`，无未知记录和未跟踪快照。

背压关闭竞态修复已在当前源代码做真实子进程 RPC 回归：下游写入失败关闭流时不再永久等待不存在的 `drain`，而是处理 CANCEL/END 并清理 RPC 通道。它另有真实 Linux noswap tmpfs ENOSPC 注入和 ARM64 客户命令故障测试。AMD64 的完整成功命令未用最终修复后的 fixture 再跑；修复后的成功命令在 ARM64 重跑，AMD64 的当前源码由完整镜像扫描、子进程 RPC 测试和真实 tmpfs 故障回归覆盖。

| 故障 | 客户命令结果与恢复 |
| --- | --- |
| ARM64 在命令期间写满 512 MiB noswap staging tmpfs | 修复后实际客户命令及时以 `BACKUP_STREAM_CANCELLED` / `DUMP_CLEANUP_UNVERIFIED` 失败、不发布集合。无法证明 dump 进程结束时 journal 保持 `stopped`，不冒充恢复成功。确认 PG18 没有 backup writer 后显式执行客户 `backup recover-maintenance`；API/Web/Caddy/PG18 恢复健康。list 无未知记录/未跟踪 snapshot；tmpfs 复位前 staging 保持需检查。 |
| ARM64 Restic reader 强杀 | `cabdd623-6785-4ca2-b454-777d0500e45c` 未发布，返回 `RESTIC_READER_EXIT_NONZERO`；显式恢复后服务健康，未知记录/未跟踪快照为 0。 |
| ARM64 PostgreSQL 在维护期间停止 | `9f6b5bf9-24d4-4c23-a880-d5ffbad11a21` 未发布；重启 PG18、确认 backup writer 为 0 后，客户恢复命令恢复原状态。此注入在背压修复前完成。 |
| ARM64 API helper SIGKILL | `bb0dd5bf-aa07-4a23-b834-bbb33a8ad91d` 未发布；客户恢复命令基于 journal 恢复服务。此注入在背压修复前完成。 |

AMD64 和 ARM64 实际并发第二个 `backup create` 都被共享部署锁拒绝；ARM64 备份期间与 `resume` 竞争同锁也被拒绝。两架构对 broker 篡改/缺失及 manifest JWS 损坏都在停服务前拒绝。每个测试发行包有 41 个工件执行 JWS 和 SHA 检查；Cosign 验证仍由测试 wrapper 模拟。错误密码拒绝、加密仓库 check、有限只读提取，以及 ACL/xattr/硬链接/符号链接/稀疏文件元数据由既有隔离回归覆盖。真实 Docker + PG18 fencer、session drain 和 prepared transaction 检查通过。`scripts/release/test-backup-deployment-metadata.sh` 未运行：指定测试镜像 `aikayun-al2023-helper-fixture-arm64:local` 不存在；没有构造占位镜像或声称该脚本通过。

## R3 完整镜像扫描（Trivy 0.69.0；2026-11-06）

冻结 API、当前 API 候选和两架构 Restic reader 均用完整 Docker image archive 检查。六次扫描使用同一 Trivy 镜像 `aquasec/trivy@sha256:33f816d414b9d582d25bb737ffa4a632ae34e222f7ec1b50252cef0ce2266006`、同一 Trivy DB v2（`UpdatedAt=2026-11-05T19:01:45.286712831Z`；`DownloadedAt=2026-11-05T20:47:12.795765094Z`；`NextUpdate=2026-11-06T19:01:45.286712591Z`）和参数 `--scanners vuln,secret --severity HIGH,CRITICAL --exit-code 0`。没有用 rootfs 局部扫描替代完整镜像，没有忽略、过滤或降低等级。

| 架构 | 镜像 | 完整 archive SHA-256 | archive config digest | HIGH/CRITICAL / secret |
| --- | --- | --- | --- | --- |
| AMD64 | 冻结 API | `6de15863dd9de8a61de844f1f288f9051780ba99cec4e0520d0f8729cda1e811` | `sha256:d3be5f5eca37bbc06679647122448163cbe673f58f74c403e09e88d01071df0d` | 1 HIGH / 0 |
| AMD64 | 当前 API 候选 | `101b7d5e7e18ad895974a123bd8c867221192bdad33868ef31406b9516106d61` | `sha256:1810b19f01ae83fe104844ff550f558d23a0a16e454e40e64719558cbb5570e0` | 1 HIGH / 0 |
| AMD64 | Restic reader | `4276f6187736a3357d1dd8d8469f1935f5369dbc3f810cd47ebbaf608ea18281` | `sha256:95ad0288f9af496fdd5e9ee2c542bb97e4232737da6f3e52975e80785e4d14df` | 0 / 0 |
| ARM64 | 冻结 API | `68c0d03c85ec089e7db5ad38afed7f5df45206cd42e1649963bfc780cc3aba3e` | `sha256:6e6fd956d5642db56b7af7e19b1c2ae85a276eb0aff681653c07e6784f4c6d5f` | 1 HIGH / 0 |
| ARM64 | 当前 API 候选 | `3e6eab6afbe206261a22a9fa062dc9b8425cab66ce744c9ea6ab5388d641611a` | `sha256:fc139738a005782d541f26a571cfa4e16d344453bd2bcb94b6802ae21ba0f97c` | 1 HIGH / 0 |
| ARM64 | Restic reader | `6c440388978db67f65a64040ac75f0f35977256b45898137a67ada06eced18c5` | `sha256:3499b94717e8f30dbfe33c954771023b3dbfc46e4d7b97cc188c208afdb17b88` | 0 / 0 |

冻结和候选 API 的唯一发现都是 `zlib1g 1:1.3.dfsg+really1.3.1-1+b1 / CVE-2026-76844 / HIGH`，Trivy 未给出修复版本；候选没有新增 HIGH/CRITICAL。原先由 API 备份 helper 工具层带入的 `libtinfo6 / CVE-2025-69720` 已消失。当前 runtime 固定为 `gcr.io/distroless/nodejs24-debian13:nonroot@sha256:b8cec4b2f2126ff7bd034ec9ac207ffb3272667dfdc48376e3b035d3270549ba`；该多架构 digest 的 AMD64 子镜像为 `sha256:1dfdd0613f3163fe913861ded2540584525b281d65541749726c7d3906382c06`，ARM64 子镜像为 `sha256:e87b0071f3ba73d76f841f5d3e013d73a9cfaed916dcb7274d2dcd06d7419a3f`。两平台从完整归档加载并导出的真实合并 rootfs 均保留 `/usr/bin/flock`，不包含 Bash、Docker CLI、Compose CLI 或 `libtinfo.so.6`。Restic reader 两架构都是 0 HIGH/CRITICAL、0 secret。

用于实际 AMD64/ARM64 客户命令的测试 trust-config API 完整归档也以同一 Trivy 数据库和参数复扫：AMD64 archive SHA-256 `7692471c3222d01aca7101e41d03bc779b55e356fd978c0de1cbd4867fe6c915`，ARM64 `b101355a863742e91c37645cbbf058b3dc3ac02fe9e96108afe757a46e9afe16`；两份均只有相同的 `zlib1g/CVE-2026-76844` HIGH，secret 为 0。它们带隔离测试发行 trust config，不是正式发行镜像。ARM64 归档用于修复后完整客户命令；AMD64 归档为当前源的构建/扫描证据，未用于重新执行 AMD64 完整命令。

## R3 验证、提交与商业发行状态

背压修复的 `pnpm lint`、定向备份测试、`scripts/release/test-backup-tmpfs.sh` 均通过。全量 `pnpm verify` 在真实隔离 PostgreSQL 18 与只读授权中心 checkout `185dac80204f60abbaa63ffeb5af7d7054b685d7` 下退出码 0：lint 0 error（7 条既有 Vue 样式 warning）；typecheck 全通过；Money 16/16；API 87 个测试文件，912 passed / 26 skipped；release 7/7；生产构建通过；Playwright 96/96、alternate brand 1/1、SSR error 4/4、dev preview 1/1、production brand 1/1（浏览器合计 103/103）。这属于本地隔离验证，不能替代准确提交 SHA 的 GitHub CI。

本地全量 `pnpm verify` 通过。首次推送提交 `f4a3c715d5be77cb2d3293a3f4e56ac42eb246dc` 的 GitHub CI 中，lint、typecheck、912 个 API 测试（26 skipped）和 7 个 release manifest 测试通过，随后 host broker shell 回归失败：测试 shim 将 macOS `stat -f` 格式用于 Linux GNU `stat`，不是备份实现断言失败。后续修复让测试 shim 根据 OS 使用相应格式，定向 `test-backup-host-broker.sh` 通过。第二次 CI 则发现身份初始化并发时，另一个进程可在目录枚举后将 staging rename 为 `current`；现已把 root-entry 检查移入已有 PostgreSQL advisory lock 内，真实 PG18 并发用例重复 10 次及完整身份集成文件 26/26 均通过。第三次 CI 的 912 API 测试通过，但 ARM64 installer command-flow fixture 出现无阶段信息的断言退出；同一 ARM64 场景在本机通过。为覆盖 QEMU 下更慢的签名工件检查，测试等待 broker-ready marker 的限时从 5 秒扩到 60 秒，并增加阶段诊断；当前精确提交 CI 待确认。代码合并条件与正式商业发行分开判定。正式发行仍被基线 `zlib` HIGH 阻断；没有正式签名发行物、生产 Cosign/OIDC 和 GHCR 验证、可信商业 Linux 主机/外部对象存储及客户恢复演练证据。High/Critical 门禁保持失败关闭，不忽略漏洞、不降低等级、不改写 SBOM。本地代码或 CI 通过不代表商业发行 PASS。

下方 R2 与 R1 章节是历史记录，不覆盖本节 R3 当前证据。

## R2 基线归因与合并判定（2026-11-05）

本次先保留完整工作树；`HEAD` 与 `origin/main` 均为冻结基线 `d48fbd12b3dc63810cd32cb032f7c9d5aea6144a`，改动仍未提交，`git diff --check` 通过。A 使用冻结基线源码和当时实际默认的 `runtime` target；B 使用当前候选源码和实际默认的 `release` target。两者均构建完整 Docker image archive，再以同一 Trivy 0.69.0（`aquasec/trivy@sha256:33f816d414b9d582d25bb737ffa4a632ae34e222f7ec1b50252cef0ce2266006`）、同一个 Trivy DB v2（`UpdatedAt=2026-11-05T13:09:41.435406326Z`，`DownloadedAt=2026-11-05T14:04:46.969244793Z`）、相同 HIGH/CRITICAL 与 secret 参数扫描。Syft 使用固定 1.38.0 (`anchore/syft@sha256:825cad3a952c87676a6d07e9a3bb05ac9c401d598360070e970aa46d54c1727e`) 对同一组完整归档生成 SBOM。无文件系统局部扫描，无忽略规则。

| 架构 | A 冻结基线完整镜像 | B 当前候选完整镜像 | A HIGH / CRITICAL；secret | B HIGH / CRITICAL；secret |
| --- | --- | --- | --- | --- |
| AMD64 | `sha256:fae1b92026f1b54b769a9cdeeae8bb93c56e9a8a7d29d929db847de4ee246bcd` | `sha256:57fe9ac03519f93db5470f4d56b6d22955f30b9c7ec7284161d0fed372b65f91` | `CVE-2026-76844` / 0 | `CVE-2025-69720`, `CVE-2026-76844` / 0 |
| ARM64 | `sha256:191c138fcb2213f853f93bb38f37f703aa56c612878396a71da0f6dcabf236e2` | `sha256:4580f79372e4426ee06e0814c271e6bc813c1ec649fbf7e7acf9c80c2a61209a` | `CVE-2026-76844` / 0 | `CVE-2025-69720`, `CVE-2026-76844` / 0 |

四个 API 镜像的基础 runtime 均为 `gcr.io/distroless/nodejs24-debian13:nonroot@sha256:b8cec4b2f2126ff7bd034ec9ac207ffb3272667dfdc48376e3b035d3270549ba`；AMD64 子镜像 digest 为 `sha256:1dfdd0613f3163fe913861ded2540584525b281d65541749726c7d3906382c06`，ARM64 为 `sha256:e87b0071f3ba73d76f841f5d3e013d73a9cfaed916dcb7274d2dcd06d7419a3f`。SBOM 组件数为 A AMD64/ARM64 `1526/1525`、B `1682/1681`。

漏洞包归属已经区分：`zlib1g 1:1.3.dfsg+really1.3.1-1+b1` 与实际 `/usr/lib/x86_64-linux-gnu/libz.so.1` 或 `/usr/lib/aarch64-linux-gnu/libz.so.1` 存在于 A、B 两侧，来自共同的 distroless runtime 根；这是基线既有 HIGH。`libtinfo6 6.5+20250216-2` 只在 B 中，实际共享库 `/usr/lib/<multiarch>/libtinfo.so.6` 及其 dpkg 状态来自新增的固定 Node 24 Trixie helper 工具层，且该层也新增 `/usr/bin/bash`。基线没有 `libtinfo6` 和 Bash。候选里没有 `/usr/bin/infocmp`，CVE-2025-69720 的已知描述针对 infocmp；这缩小了镜像中可调用的受影响组件范围，但不改变 Trivy 对 `libtinfo6` 的 HIGH 结果，也不足以声称不存在风险或隐藏扫描结果。

Trivy 对上述两种包均未提供 `FixedVersion`。Debian 安全跟踪器当前仍标记 Trixie 对 CVE-2025-69720 和 CVE-2026-76844 受影响；zlib tracker 还显示更高版本流仍受 CVE-2026-76844 影响，只有 sid 当前标记已修复。没有证据支持把未经确认的新版基础镜像、测试发行版或手工库覆盖作为本轮修复。[Debian ncurses tracker](https://security-tracker.debian.org/tracker/source-package/ncurses)、[Debian zlib tracker](https://security-tracker.debian.org/tracker/source-package/zlib)。

**R2 判定：两项 HIGH 并非都存在于冻结基线。**每个架构的 zlib HIGH 是基线遗留；`libtinfo6` / CVE-2025-69720 是本轮候选新引入的扫描阻断，而且 API helper 镜像也增加了 Bash、Docker CLI 与 Compose CLI。尽管 helper 受固定签名 digest、安装器校验、部署锁、封闭参数和只读/最小 capability 启动约束，这仍是候选运行镜像内容及可用工具面的增加。按本阶段明确的合并条件，本轮不能提交或推送 `main`。正式发行门禁继续对所有 High/Critical 拒绝，不忽略 CVE、不降等级、不改写 SBOM。没有适合在 R2 里直接套用的受支持 Trixie 修复；不得仅凭 infocmp 不存在而放行。

### 生产命令调用链审查与验收边界

代码检查确认，客户命令由发行包内固定宿主 launcher 发起；发行包验证器校验保存的签名 release，宿主 probe 校验 API 镜像签名、digest 与 helper 文件 SHA，launcher 使用原安装器 flock 后将同一锁交给 API helper。容器内 helper 使用封闭命令参数和干净环境，再次核对锁、部署指纹、签名 release、固定路径、数据库目标和 Restic reader digest。创建过程先持久写维护 journal，再停止原先运行的 API/Web/Caddy 与数据库写入角色，检查残余写入者，捕获 PG custom dump 和只读 Restic 卷快照；恢复服务与角色并验证原状态后才发布 manifest snapshot 和 `verified` 成对记录。未知的 Docker/PG 操作结果、强杀、锁丢失或无法证明的清理会保留 journal/staging 或 `uploading` 记录并 fail closed，不输出原始异常内容，也不会把未知上传标成完整。Restic reader 从签名 manifest 的 digest 创建，源卷只读、容器 rootfs 只读、无网络、丢弃全部 capabilities 后仅加 `DAC_READ_SEARCH`，不挂 Docker socket。固定备份 root、目录、独立密码、Docker CLI、socket、lock 和 staging 的 owner/mode/realpath 都有显式检查；普通开发参数不能选择生产路径。

本轮已通过的隔离测试包括完整 `pnpm verify`（详见下方历史记录）、真实 PostgreSQL 18 与实际 release Compose 拓扑的直接捕获/双 snapshot 发布/恢复/配对校验、Restic 完整加密读写/检查/有限提取、错误密码拒绝、强杀恢复、锁交接以及 AMD64/ARM64 Restic reader 扫描。**但这组真实 PG18 集成测试直接调用 `captureDirectUnpublishedSet`、`DirectResticVolumeReader` 和 `publishDirectCapturedSet`；没有从发行包中的客户 `backup create` 命令经过生产 signed helper 跑完整 `runFixedProductionBackup`。**固定 runtime 单测替换了底层依赖；安装器锁交接测试用 fixture helper CLI 替身。因此不能把这些证据等同于“生产形态备份命令已在隔离发行 Compose 完整执行”。本轮未在 Linux 商业宿主验证 root-only `/opt/aikayun`、安装器锁、签名 artifact、noswap tmpfs 的端到端客户命令路径，也未执行公开 GHCR 拉取。该项仍是明确的代码验收缺口。

其余检查范围覆盖了停写/恢复状态机、数据库与身份/Trust Store/历史 key-ring 对应关系、Restic 镜像 digest 和挂载/权限约束、生产 Compose 服务、安装器固定命令入口、失败清理和安全错误输出；未发现可以凭目前证据放行的手工跳过门禁或错误完成路径。以上源码审查结论不消除前述候选新增 HIGH，也不替代尚未执行的生产形态端到端命令验收。

## 当前本地发行候选记录（2026-11-05；被上方 R2 对照补充）

本轮 ARM64 API `release` 候选镜像 ID 为 `sha256:4633c160dbafeccc5fb783af5eccb995d81ba418e16ceb4f08521341abf78bbc`，AMD64 为 `sha256:0acf3a2941d71aed54ac860dddebc1116c472297f8008db1828c86a41e34c8fe`。固定 Syft 1.38.0 从两个完整 Docker archive 分别生成 1,681 与 1,682 个组件的 CycloneDX SBOM；Restic 组件数均为 0，`reject-unverified-restic-helper.mjs` 对两份 SBOM 均通过。SBOM 中的 npm `tar@7.5.22` 是 JavaScript 包；生产 helper 探针确认 `/usr/bin/tar`、`infocmp` 不存在。

当前 API 候选的 Trivy 结果与扫描参数、完整 archive、数据库时间戳以及 A/B 冻结基线归因见上节。这个候选每个平台 2 个 HIGH；不能把这个总数表述为“两个均在基线已存在”。

独立 Restic reader 的当前 ARM64 镜像 ID 为 `sha256:7aef8e5f6b220472d887fb89cf0ca0331eed6343070761f498fdbc8cc2b59fa4`，AMD64 为 `sha256:b1d9bc58144bccb69d40d4f72a7c0da8bc9bdffc4f33ef6bf988aa1962275f50`。各自完整 SBOM 为 82 个组件；固定 Trivy 对实际 archive 的 HIGH/CRITICAL 和 secret 扫描均为 0。它们是未签名本地候选，不是 GHCR digest 或已发布发行物。API Restic 组件拒绝门已解除，但 API 完整镜像仍被一项基线遗留 HIGH 和一项候选新增 HIGH 阻断；本轮因此不提交、不推送、不发布。

## 已核对的发行布局

⑦-3 安装器使用 `/opt/aikayun` 和 `/run/lock/aikayun-install.lock`。数据库、应用状态、Caddy 数据和配置分别使用固定卷 `aikayun_postgres_data`、`aikayun_state`、`aikayun_caddy_data`、`aikayun_caddy_config`。应用状态卷必须整体纳入：其中包含媒体、完整私有文件、安装身份、Trust Store、Pending Key、可信时间水位和恢复材料。数据库必须使用 PostgreSQL 18 的 custom-format `pg_dump`，不能归档运行中的 PGDATA。

部署集合还须包括 `/opt/aikayun` 下的安装状态、部署配置、发行清单与签名工件，以及 `secrets` 下的数据库凭据和完整支付、交付历史密钥环。Caddy 持久数据和配置也应纳入。备份密码必须独立于备份仓库存放，不写入清单或日志。

固定路径约定要求客户独立保管并预先放置 `/etc/aikayun-backup/restic-password`，属主 root:root、权限 0600；程序不生成或输出该密码。初始化记录与 Restic 仓库 ID 配对，初始化结果未知时不能盲目重试。入口已在发行包组装路径中，尚未随新签名正式发行。

## 必须解决的一致性边界

安装器 flock 不会约束直接使用 Docker 或 PostgreSQL 的操作者，文件检查 CLI 也会写数据库。正式维护入口现通过继承同一 flock、持久 maintenance journal、停止并核对服务、阻止应用与迁移角色登录、检查剩余数据库连接和卷写入者来建立一致性边界；未知写入者 fail closed。拥有宿主 root 或 Docker 权限的直接绕过仍属于可信管理员边界，需在部署手册中保留说明。

任何停止服务或改变数据库访问策略之前，应持久记录原始状态，使正常失败和 SIGKILL 后的后续检查能够识别未完成操作；只有核对过原始状态与部署身份后才能恢复原先运行的服务。被强杀的进程无法依靠 shell trap 立即清理或重启。不得将部分上传、超时或未知结果标记为完整备份。

## 仍未验收的正式环境条件

正式 Linux 宿主上的安装器锁交接、`/opt/aikayun` bind 读取、noswap tmpfs、外部对象存储、正式密钥托管、实际发行签名与匿名拉取，以及真实客户商业恢复演练尚未验证。本阶段不实现生产恢复、升级或迁移。测试均为隔离环境，不代表公网商业运维验收。

**旧归档路径的局限仍然成立：**PostgreSQL 镜像 BusyBox `tar -cf` 会丢失扩展 ACL、user xattr，并展开稀疏文件；旧 `captureReleaseVolume` 仍硬失败。生产入口现在只用 PostgreSQL custom dump 加 direct Restic 只读卷快照，不再调用该归档 helper；旧归档验证代码保留用于历史集合检查。

## ⑦-5A-R1 直接卷读取与 Restic 运行镜像实测

截至 2026-11-05，固定多架构官方镜像 `restic/restic@sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510` 的 AMD64 和 ARM64 Restic 均实际启动成功，但现有 Trivy 0.69.0 High/Critical 门禁拒绝两个平台：每个平台各报告 13 个 Alpine 软件包漏洞（10 HIGH、3 CRITICAL），另有 22 个 Go 二进制漏洞。没有使用忽略 CVE 或降低等级的选项。

新增 `restic-runtime` Dockerfile 目标以固定 Go 工具链从经校验的 Restic 源码构建静态二进制，并以 `scratch` 作为运行根，仅加入 Restic、公共 CA 证书包及对应版权文本。AMD64 和 ARM64 实际启动版本均为 `restic 0.19.1-aikayun.2 / go1.27.3`。2026-11-05 06:38 UTC 对这两个实际构建的镜像归档分别执行固定 Trivy 0.69.0 漏洞与 secret 扫描：报告时间分别为 06:38:02Z 和 06:38:06Z，High/Critical 为 0、secret 命中为 0；Syft 1.38.0 各输出 82 个组件。两平台版权文件 SHA-256 均为 `e85e1bcad3a915dc7e6f41412bc5bdeba275cadd817896ea0451f2140a93967c`。这是本机 Linux VM 上的候选镜像证据，不是已发布或签名镜像证据。

在 Docker Linux VM 的真实 Linux named volume 上进行了直接只读读取和 Restic 往返验证。测试源包括：SHA-256 已核对的业务文件（UID/GID 1234:2345，0640）、POSIX ACL 用户项、`user.*` xattr、硬链接、相对符号链接、UID/GID 1000:1000 且 0400 的身份私钥样本，以及逻辑大小 1 GiB、初始仅分配 8 个 512 字节块的稀疏文件。Restic 源容器使用只读根文件系统、无网络、无 Docker socket、仅 `CAP_DAC_READ_SEARCH`、卷只读挂载和有限 `/tmp` tmpfs；数据已加密入库，再用 `restore --sparse --verify` 提取复核。业务文件 SHA、内容、属主、权限、ACL、xattr、硬链接 inode 关系、符号链接目标、私钥读取权限均保持；稀疏文件逻辑大小和尾部内容一致，恢复后仍为 8 个块。这个结果说明物理空洞位置不需要成为生产备份全局阻断，但需要继续用实际业务目录和正式 Linux 主机文件系统复验。

加密仓库的 `check --read-data` 对 3/3 个 packs 通过；错误密码被 Restic 以退出码 12 拒绝。实测还确认 Restic 即使执行列表等操作也可能需要在仓库中建立锁，因此仓库挂载不能只读；只读限制应放在数据源卷。`scratch` 根文件系统必须提供受限 `/tmp` tmpfs，否则备份会因临时 pack 文件无法创建而失败。用 Docker local volume driver 建立了共享的 `type=tmpfs` 卷；容器内 mountinfo 确认其带 `noswap,nosuid,nodev,noexec`，可供协调容器与独立 Restic 容器共享受控暂存目录。

R1 的 `DirectResticVolumeReader` 已集成到 `runProductionBackupRuntime` 和固定 signed helper：读取器只接受授权 release manifest 中的签名 digest 镜像，检查生产卷和协调器验证过的 noswap staging 后，以无网络、只读根、`CAP_DAC_READ_SEARCH`、只读源卷/部署目录运行；仓库可写、密码只读，容器没有 Docker socket。staging 通过只读 bind mount 复用现有暂存目录，不另建临时 Docker volume。每个候选容器在执行前检查镜像 ID、命令、capability、namespace、安全选项及完整挂载清单；完成时必须有成功退出状态和唯一 snapshot ID。超时或未知状态 fail closed 并保留现场。reader 无需 tar helper。

2026-11-05 又在随机项目名的实际发行 Compose 隔离副本中运行了 `DirectResticVolumeReader`，对应 Vitest 1/1 通过：PostgreSQL 18、API、Web、Caddy 均按发行 Compose 启动，快照期间停止 API/Web/Caddy，恢复后确认这些服务重新运行。Restic 容器直接只读挂载该 Compose 实例的状态、Caddy data 和 config Linux volumes；仓库和密码使用独立测试路径。最初使用本地官方 `restic/restic` 镜像时，Docker Desktop 把 macOS 主机目录作为源 bind mount 会让 Restic 对部署目录样本返回 `input/output error`，尽管同一容器能用普通 `cat` 读取该文件。因此这次通过的真实容器验收用隔离 Linux volumes 提供部署配置和 staging 测试内容；这验证了 Restic 对 Linux 文件系统卷、Compose 状态/Caddy 卷布局、加密快照和恢复的读取能力，**不证明正式 Linux 宿主上的 `/opt/aikayun` 与 noswap staging bind mount 已端到端验收**。随后使用本仓库 `restic-runtime` Dockerfile 目标构建的 ARM64 本地 `scratch` 候选镜像 ID `sha256:f64ce8092a8814e7ddd363f910c755472f57b479d8090cba2fd105ec388fe0ef` 重跑同一容器验收，1/1 通过。该镜像未签名、未发布；本地构建 ID 不是发行 digest。

随后新增真实 PG18 source 与 paired manifest 全链路隔离测试。发行 Compose 中的 API/Web/Caddy 和 PostgreSQL 18 实际启动；服务写入者停止并恢复，custom `pg_dump` 绑定真实数据库 metadata，Restic source snapshot 校验身份、Pending Key、Trust Store marker、部署密钥环和数据库 dump SHA；生产卷 marker 的规范内容允许初始化器写入的单个末尾 LF，也兼容历史无换行形式，额外字节仍拒绝。之后单独发布 manifest snapshot，并由最终 customer verifier 重新检查两快照及当前 helper UID/GID、文件模式。使用本机 ARM64 `restic-runtime` scratch 候选镜像 ID `sha256:d3659e070c5958ca26907554b5e89d09c7d2b53d5c14b1bb6ab66e2cb35b4078` 的该测试 1/1 通过，snapshot pair `verified`；服务停写到恢复约 28.9 秒。测试专用 wrapper 将暂存 manifest 复制进随机命名、带 fixture label 的 Linux named volume，并把该 volume 挂到原绝对路径，以避开 Docker Desktop 对 host bind 的 `input/output error`；因此这是实际 PG18/Compose/Restic 配对证据，**仍不代替正式 Linux 宿主 bind-mount 验收**。测试容器、卷、网络、wrapper 和临时数据由 fixture 清理。

2026-11-05 12:48 UTC 又用当前 API ARM64 候选 `sha256:4633c160dbafeccc5fb783af5eccb995d81ba418e16ceb4f08521341abf78bbc`、当前 ARM64 Restic reader `sha256:7aef8e5f6b220472d887fb89cf0ca0331eed6343070761f498fdbc8cc2b59fa4`、当前源码构建的 Web 镜像 `sha256:cf351eaf3bb08a652c2a89af9a6bc652d857ef779b6e02652a6541fccd4e392d` 和真实 PostgreSQL 18 重跑配对验收，1/1 通过。API、Web、Caddy 与数据库均在随机发行 Compose 隔离实例内启动；source/manifest snapshots 配对并通过最终验证，数据库角色和原先运行的服务均恢复，本次停写实测 29,324 ms。Restic 命令执行器的独立 Docker 镜像集成测试也分别对当前 ARM64 `sha256:7aef8e5f6b220472d887fb89cf0ca0331eed6343070761f498fdbc8cc2b59fa4` 与 AMD64 `sha256:b1d9bc58144bccb69d40d4f72a7c0da8bc9bdffc4f33ef6bf988aa1962275f50` 通过 1/1；初始化仓库、备份、check、列出 snapshot、读取文件哈希及受限流式提取均通过。两组都是本地未签名候选和合成数据，不代表正式 Linux 宿主、公网对象存储或商业发行验收。

2026-11-05 又按当前 Dockerfile 分别重建了未发布的 ARM64 与 AMD64 scratch reader 候选：本地镜像 ID 为 ARM64 `sha256:d3659e070c5958ca26907554b5e89d09c7d2b53d5c14b1bb6ab66e2cb35b4078`、AMD64 `sha256:64a87143bda0e880c347ec6bb8836f76bb4d92d153dc0527fa1c3f4db01192fc`；两者均实际启动并输出 Restic 0.19.1-aikayun.2 / Go 1.27.3。固定 Trivy 0.69.0 对两份 Docker archive 分别执行 HIGH/CRITICAL 漏洞与 secret 扫描，均为 0；固定 Syft 1.38.0 各生成 82 个组件的 CycloneDX SBOM。ARM64 scratch 候选同时用于上面的真实 PG18 完整配对复验。以上是本地按当前源码重建的候选证据，不是 GHCR digest、签名或已发布发行物；API SBOM 专用的 `reject-unverified-restic-helper` 门禁不适用于独立 backup-reader SBOM，后者仍须通过独立 license/NOTICE/签名发行链。

同一快照从 Linux volume 恢复后，身份样本 SHA-256、内容、UID/GID `1234:2345`、权限 `0640`、POSIX ACL、`user.*` xattr、硬链接 inode 和符号链接目标均通过断言。稀疏样本逻辑大小 64 MiB，源卷占用 8 个 512 字节块；默认恢复后逻辑内容与尾字节正确，但占用为 131072 个 512 字节块（64 MiB），空洞变为实数据块。这证明稀疏布局不应作为业务阻断；当前业务没有依赖物理空洞位置的证据。它也与上文另一组显式 `--sparse` 的试验不同，不能据此声称 Restic 默认恢复会保留稀疏分配。

R1 现已把 `backup` 镜像纳入发行清单 schema、双平台候选构建、Trivy/Syft 流程、安装器 digest 拉取与 Cosign 校验，以及 SBOM/NOTICE 工件清单。新增的 NOTICE 准备脚本用固定 Go 工具链、Restic 二进制实际 build info 和离线模块 license cache，调用原 NOTICE 生成器并使用固定 Trivy 0.69.0 扫描 NOTICE 文件。最终脚本在 AMD64 与 ARM64 本地端到端运行均通过，NOTICE secret 扫描为 0 findings；八种 NOTICE 文件名的 Trivy 正向 canary 均命中。该本地演练传入的是合成 digest，因此这次生成文件的 SHA（amd64 NOTICE `1c35ce72d431732c8326ae3306cf02277fb142b4f7e6924c06ee56ddbd2d8958`、扫描摘要 `5a66fa2c0d689b30638e0da7a6eb43546066cff96de99daab8cd8954110d50bf`；arm64 NOTICE `d692d5d3f193df5b53482b64ffab9a9d04cc6f86c97bf6e91cbfc328cf43e100`、扫描摘要 `e83e268707bd46e8df3538dad859e9138e0fac03992b869e0f985b72b87e19f2`）仅作脚本实跑证据，不能放进发行包。发行脚本未连接 GHCR、未签名，也没有匿名拉取验证。

对上段之后按当前 Dockerfile 重建的两个本地候选，还单独执行了完整 archive 级 Trivy/Syft 与真实 `prepare-backup-reader-notice.mjs` 发行步骤：两平台 SBOM 各 82 个组件，漏洞扫描 HIGH/CRITICAL 为 0，secret 扫描为 0；Go license evidence 中的二进制 SHA 与实际 reader 一致，NOTICE 生成和 NOTICE secret scan 均通过。ARM64 当前本地 NOTICE SHA `cb69de09f4dbf0381bf3991e094eddbb2c05c2ba4c6d698a40e1e145421258c7`、扫描记录 SHA `bf00d7daa8428c6a34d5c7016fbe32fbbbca374fb5a7eaef56757c7aa0b9ad4b`；AMD64 NOTICE SHA `95363760f383a951b333c6768a8da5350414c16a151291a58d6b0fdbd0374f97`、扫描记录 SHA `f2cbf9b3290cdcbae231ec5e43cbec0b66e97c925961a61656be59e871cbfcf3`。这些 artifact/image IDs 都是无签名本地候选证据，不是 GHCR index digest 或正式发行物。

reader digest、backup CLI 与 helper 接线之前的完整验收快照仅作历史记录，不代表当前 source。

**剩余发行验收：**direct reader、PG18 dump、配对发布、固定宿主 CLI、signed API helper、安装器 digest preflight/lock handoff 和 release assembly 已接线并在隔离环境测过。本文所述 candidate 未签名、未发布，也未在正式 Linux 主机、公网对象存储、真实客户数据和商业恢复演练上验证；本地 `pnpm verify` 不能替代最终提交 SHA 的 GitHub CI。不得将候选镜像扫描或隔离 PG18 通过表述为公网商业发行验收。

较早的 Compose smoke test 只证明拓扑能启动；其后 `backup-direct-real-set.integration.test.ts` 进一步完成捕获、恢复、paired publication 与 final verification。两类测试均使用随机项目、隔离卷/网络和合成密钥；不证明签名发行或正式服务器恢复。

生产组合组件已分别对 PostgreSQL custom dump、direct 只读卷读取、身份与 Pending Key 绑定、密钥 ID 覆盖、维护状态日志、Restic 加密存取与只读工件复核进行隔离测试；但尚未形成已签名、已发布并在正式主机安装的发行版本。Docker 客户端中断不保证容器内 dump 已结束，清理未确认时维护状态必须保留，不能启动原服务。身份检查会比对私钥推导的公钥和数据库绑定，但历史业务密钥 ID 存在不证明所有历史密文可解密。当前仅在临时环境验证 `noswap` tmpfs，原生 Linux 生产宿主的锁交接和安全暂存仍未验收。

随机发行 Compose 测试已使用真实 PostgreSQL 18、三个隔离卷和本机 restic 完成捕获、服务恢复和解密复核。停写后、数据库导出被锁阻塞时以及 restic 写入数据期间的三个真实 SIGKILL 窗口分别验证了维护记录、部分工件或上传未决状态；检查和显式恢复后，测试数据、原服务与数据库角色状态一致。测试中的发行签名、宿主锁及临时存储证明均为替身，因此这些结果不能证明正式宿主链已经验收。

新增的 Trust Store 检查只读取状态文件和独立 checkpoint，不调用具有崩溃恢复副作用的 `getAccepted()`。创建备份时，它在 PostgreSQL 共享 advisory lock 下校验 root 签名、checkpoint/state 配对、签名 bundle 身份及数据库 head；数据库存在 pending 更新、head 不一致或 checkpoint 未完成时拒绝备份且不改文件。归档校验通过 tar 流解析器只收集两个有大小上限的 Trust Store 文件，在私有暂存目录中交给同一个只读解析器验证；没有把签名 token 或密钥内容写入备份清单。验收旧快照时会重新验证归档内的 root 签名与 checkpoint，并比对清单记录的版本、artifact digest、state digest 和撤销/退役计数。Trust Bundle 过期不会使其历史签名证据失效，因此该检查不以当前有效期判定历史快照损坏；经营授权状态仍由商城原有授权流程判定。

`backup-real-set.integration.test.ts` 已在隔离环境中额外走通：真实 PostgreSQL 18、随机 Docker 卷、数据库 head 已绑定到测试根签名 Trust Bundle、PG 18 custom dump、密钥引用、Restic 加密快照发布以及解密后的身份、Trust Store 和数据库绑定复核，1/1 通过。测试签名根和授权中心 key 都是本轮临时生成的测试 key，数据库与卷均为合成数据；这不验证正式发行 Trust Bundle、生产安装器签名或真实授权中心。

2026-11-05 当前工作树的完整 `pnpm verify` 在独立 loopback PostgreSQL 18 `aikayun_test` 容器和只读授权中心 SHA `185dac80204f60abbaa63ffeb5af7d7054b685d7` 下退出码 0：lint 0 error（7 条既有 Vue 样式 warning）、Contracts/Money/API/Web typecheck、Money 16/16、API 86 个测试文件 `903 passed / 26 skipped / 0 failed`、release 7/7、API/Web production build、Playwright 主套件 96/96、alternate brand 1/1、SSR error 4/4、dev preview 1/1、production brand 1/1（浏览器合计 103/103）。生产 Compose PG18 配对捕获另有 1/1 通过，停写实测 29,324 ms；Restic 命令容器 AMD64、ARM64 各 1/1 通过；安装器 `backup-lock-handoff-verification` AMD64、ARM64 均通过。此次临时数据库容器、专用卷和凭据已清理。以上是本地隔离验收，不替代本 SHA 的 GitHub CI，也不证明正式 Linux 宿主、公网对象存储、签名发布或商业恢复演练。

隔离 HTTPS S3 兼容端点上的真实 restic 复制和远端完整数据读取检查通过。证书不受信任或端点失联时，restic 会重试；强杀测试中的 restic 后观察到本地仓库锁。另一个独占隔离仓库测试中，确认相关进程退出后执行普通 `restic unlock`，再完成 `check --read-data`，快照 ID 与三个测试文件的 SHA-256 均保持一致。这仅证明该隔离情形；不能假定强杀后仓库立即可用，也不能自动执行 `unlock --remove-all`。未连接真实对象存储，业务模块与实际 S3 的端到端联动仍待验证。
