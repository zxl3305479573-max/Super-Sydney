<!-- pi-memory:start -->
## 项目记忆

- [decision] 公众号工作流架构：复用 WeWrite（~/wewrite）当引擎，不自建。定制层全部放在仓库外，避免 git pull 冲突：① 状态层 ~/.wewrite/（style.yaml、personas/、themes/，优先级高于内置）；② 提示词层 ~/.agents/skills/wewrite-elder-health/（领域约束 skill + references）。理由：WeWrite 本身就为定制预留了 ~/.wewrite 覆盖点，pi 原生支持 ~/.agents/skills。定位为"面向中老年读者的身心健康科普，严格科普不诊疗"。
- [pitfall] WeWrite 在 Windows 的三个坑（非仓库可读出，实测得出）：① wewrite CLI 在 Windows 控制台会以 UnicodeEncodeError: 'gbk' codec 崩溃，所有调用必须带 PYTHONUTF8=1 PYTHONIOENCODING=utf-8。② install.sh 的 ln -sfn 在 Git Bash 下退化成目录复制而非软链，因此改用 Windows 目录联接（New-Item -ItemType Junction）指向 ~/wewrite/skills/*；副作用是以后更新只需 git pull，绝不能再跑 install.sh（会覆盖成复制并冲掉定制）。③ 自定义主题的 darkmode 必须内嵌在 colors: 下，写成 colors 的同级键会被 converter 静默忽略（converter 只读 colors['darkmode']）；上游 18 个内置主题中有 12 个存在此问题，照抄 bold-green 会继承这个 bug。
- [decision] 公众号模块的集成契约（应用侧决定，非仓库可读出）：① 职责边界——应用只读 ~/.wewrite/runs 状态并触发确定性 CLI 命令，选题/写作/审稿属提示词层必须由 agent 执行；② 发布授权按"本次点击"授予（run permission publish allow），推送后立即 deny，使每次推送都需要新的人工确认，符合"外部发布必须人工确认"原则；③ 发布有两个硬前置：微信凭证 + 封面图，封面按 用户选择 > images.json 启发式扫描 的顺序解析；④ 预览默认主题取 style.yaml 的 theme，且必须显式传给 CLI；⑤ 走独立 IPC 命名空间 wewrite:*，不进 state:get（因为要 spawn Python，会拖慢整个界面刷新）。
<!-- pi-memory:end -->
