<!-- pi-memory:start -->
## 项目记忆

- [decision] 公众号工作流架构（2026-10 更新，取代"复用 WeWrite 当引擎"的旧决策）：桌面端原生管道是主链路，应用直接调内容 API 完成选题、写作、审稿、配图、预览与草稿推送，不再调用 WeWrite CLI；「WeWrite 兼容」标签与 wewrite:runs/preview/publish 等 10 个 CLI 通道已删除。仍保留的共享点只有 ~/.wewrite/style.yaml 与 config.yaml（原生管道与 agent 侧 skill 共用）以及 ~/.agents/skills/wewrite-elder-health（agent 在对话里写作时的领域约束）。定位为"面向中老年读者的身心健康科普，严格科普不诊疗"。
- [pitfall] WeWrite 在 Windows 的三个坑（非仓库可读出，实测得出；应用已不调 CLI，但 agent 侧仍会用到）：① wewrite CLI 在 Windows 控制台会以 UnicodeEncodeError: 'gbk' codec 崩溃，所有调用必须带 PYTHONUTF8=1 PYTHONIOENCODING=utf-8。② install.sh 的 ln -sfn 在 Git Bash 下退化成目录复制而非软链，因此改用 Windows 目录联接（New-Item -ItemType Junction）指向 ~/wewrite/skills/*；副作用是以后更新只需 git pull，绝不能再跑 install.sh（会覆盖成复制并冲掉定制）。③ 自定义主题的 darkmode 必须内嵌在 colors: 下，写成 colors 的同级键会被 converter 静默忽略（converter 只读 colors['darkmode']）；上游 18 个内置主题中有 12 个存在此问题，照抄 bold-green 会继承这个 bug。
- [decision] 公众号模块的集成契约（应用侧决定，非仓库可读出）：① 外部发布必须人工确认——草稿推送每次都要用户在界面点击并二次确认；② 发布有两个硬前置：微信凭证 + 封面图；③ 预览默认主题取 style.yaml 的 theme；④ 保存配置时 topics / default_topic 以本机内容方向分类表为准，不拿表单旧值覆盖；⑤ 公众号配置走独立 IPC 命名空间 wewrite:*（overview / config:save / environment），不进 state:get。
<!-- pi-memory:end -->
