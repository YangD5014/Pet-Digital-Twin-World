# 猫咪探索 · 院子漫步（cat-game）

Three.js 第三人称猫咪探索小游戏：在 `场景.glb`（Sketchfab 院子）里操控 `cat.glb`
的三花猫漫步、疾跑、跳跃。骨骼动画 Walk/Run 取自 `猫咪绑定_动画1.blend`，
经 Blender 5.0.1 无头导出烘焙进 `data/cat.glb`。

模型已做 **KHR_draco_mesh_compression** 压缩（scene 12.1→6.6MB，cat 4.5→3.2MB），
加载时由 `DRACOLoader`（`vendor/draco/`）解码；压缩命令：
`npx @gltf-transform/cli draco in.glb out.glb`。

## 运行

```bash
cd cat-game
python3 -m http.server 8792
# 打开 http://localhost:8792
```

（ES Module + GLB 需要 http 服务，直接双击 index.html 不行。）

## 操作

| 按键 | 功能 |
| --- | --- |
| W A S D / 方向键 | 相机系移动 |
| Shift | 疾跑 |
| Space | 跳跃 |
| 鼠标左键拖拽 | 旋转视角 |
| 滚轮 | 缩放（1.5–9m） |
| H | 猫咪设置面板（localStorage 记忆） |
| R | 回出生点 |

设置面板：走路速度 / 疾跑速度（m/s 绝对值）、高度偏移（修穿模）、跳起高度、重力、转向速度、相机距离。
静止时猫保持完全静止的站姿（无待机动画）。
走路速度 >0.45m/s 时自动切换奔跑动画（步频限制）。

## 素材与测量（来自 Blender 脚本实测）

- 场景：Sketchfab 导出，Maya 量纲按 **cm → ×0.01** 转米（院子约 18×19m）。
- 猫：`猫咪绑定_动画1.blend` 只选蒙皮网格 + 眼球（骨骼挂载）导出，cat 全长
  5.19 glTF 单位 → **×0.25 ≈ 1.30m**。朝向：Blender -Y → glTF +Z（标准朝前）。
- 步态（原地循环，root 每周期位移 ≈0，脚部 stance 位移即步幅）：
  - Walk 161f（5×32f）@24fps：步幅 ≈0.30–0.34u，**速度 0.3689 u/s**
  - Run 81f（5×16f）@24fps：步幅 ≈0.57–0.72u，**速度 3.4464 u/s**
- 消滑步原理：原地循环中 stance 期间脚掌相对 root 后移 stride，游戏里
  root 前进速度 = stride/stance时长 时脚掌世界静止。任意倍速 k 下
  `timeScale = k` 且 `速度 = k × native` 依然精确无滑步，所以玩法速度用
  `CFG.walkK / runK` 自由调节。

## 代码结构（src/main.js）

- 加载：字节级进度条（scene 0.72 / cat 0.28 权重）
- 出生点：全场景向下射线 → 高度分桶面积投票（最多票层级=主步行面铺装，
  自动避开池底/树冠）→ 该层级里离中心最近的开阔点（8 向 1.2m 净空检查）
- 控制器：朝向平滑转向（先转身再走）、重力跳跃、双高度墙面射线 + 贴墙滑移、
  地面射线贴地
- 相机：球坐标跟随 + 入墙回拉 + 贴地钳制（高墙顶部不算地面，改为拉近）
- 动画：Walk/Run 常驻 mixer 用权重混合，`timeScale = speed/native`；
  待机为程序化摆动（尾链正弦摆 + 头部微动 + 脊柱呼吸），mixer 烘焙通道
  的骨骼做加法叠加，无通道骨骼用基准快照
- 调试：`window.__game` 每帧状态快照；`window.__DBG = true` 开启输入日志；
  页面顶部红条显示未捕获异常

## 调参

全部在 `src/main.js` 顶部 `CFG`：速度倍率、猫/场景缩放、跳跃、转向、相机。
