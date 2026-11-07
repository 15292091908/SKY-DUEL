// js/config.js — 《苍穹对决》全局可调参数（v3.3 从 main.js 抽出）
// 所有游戏性数值集中在此：改数值不必翻主文件。导出后各模块按需 import。

export const GAME_VERSION = 'v3.19.0 安卓版';   // [ANDROID] 安卓版独立版本号（底层游戏快照 v3.19.0）
export const MODE_SIZE = { 'net': 2 };
export const SPAWN_Z = 900;
export const AAGUN_HP = 150;
/* ===== 火箭弹推进：三个状态（v3.19）=====
   0        ~ IGNITE_T   点火  推力沿弹轴，速度从 **0** 线性涨到 V_MAX（并受重力）
   IGNITE_T ~ FUEL_T     巡航  燃料还在烧，推力矢量配平阻力与重力 → 速度大小、方向都维持
   FUEL_T   ~ 寿命        无动力 二次阻力减速 + 重力下坠，越飞越慢、越飞越低
   尾焰只在①②两段可见。水平发射时①+②正好飞 BOOST_RANGE（由 FUEL_T 反解保证）。

   现实参照（RPG-7）：无后坐力炮先给出 117 m/s 出膛速度，10m 后火箭点火，
   烧 1.5s 加速到 294 m/s，之后纯惯性飞到 920m 自毁。也就是说真实是「炮射 + 火箭增程」，
   **不是**从零起步。这里按用户要求做成纯火箭从零点火（离架初速 0），
   并把「巡航段维持速度」作为游戏化的推力矢量控制（无制导火箭弹真实会持续被重力拉弯）。 */
export const ROCKET_V_MAX = 300;        // 燃料段能达到的最大速度（m/s；比机炮 880 慢，肉眼可追）
export const ROCKET_IGNITE_T = 1.0;     // 点火加速时长（s）：0 → V_MAX
export const ROCKET_BOOST_ACCEL = ROCKET_V_MAX / ROCKET_IGNITE_T;   // 推力加速度（m/s²）
export const ROCKET_BOOST_RANGE = 500;  // 燃料段的标称水平路程（m）
// 燃料时间由「点火半程 + 巡航全程 = BOOST_RANGE」反解：R = V_MAX·(T − IGNITE_T/2)
export const ROCKET_FUEL_T = ROCKET_BOOST_RANGE / ROCKET_V_MAX + ROCKET_IGNITE_T / 2;   // ≈2.17s
export const ROCKET_SPEED = 0;          // 离架初速：0 = 从静止点火（用户要求"从零开始加速"）
export const ROCKET_AVG_SPEED = ROCKET_BOOST_RANGE / ROCKET_FUEL_T;  // 燃料段平均速度（AI 提前量 / 多普勒音效用）
/* 无动力段阻力：真实二次阻力 dv/dt = -c·v²。
   c = ½·ρ·Cd·A/m。RPG-7 弹体：m≈2.25kg、A=π·0.035²≈3.85e-3m²（70mm）、Cd≈0.45、ρ=1.225
   → c ≈ 4.7e-4 /m。300 m/s 时减速度约 −42 m/s²，1 秒后剩 88%、3 秒后剩 70% —— 也就是"缓慢减速"。 */
export const ROCKET_DRAG_Q = 4.7e-4;    // 二次阻力系数（1/m，仅无动力段生效）
export const ROCKET_GRAVITY = 9.8;      // 重力下坠（m/s²，真实值；旧版写 38 是为了看得出下坠而放大的）
export const ROCKET_LIFE = 9;           // 寿命（秒）
export const ROCKET_PROX_R = 10;        // 近炸引信触发半径（米）——**只对敌方生效**，队友必须实碰（v3.13）
export const ROCKET_BLAST_R = 40;       // 爆炸波及半径（与房主命中校验阈值一致，保证波及伤害能通过校验）
export const ROCKET_DMG = 150;          // 主目标伤害（飞机 HP 100 → 一击致命）
export const ROCKETS_PER_AAGUN = 2;     // 每辆车/每架机的备弹（左右各 1 个发射巢，v3.17.1 按用户口径修正）

/* ===== 爆炸物引信（v3.13，v3.14.5 移除空中拦截）=====
   弹药只能由引信 / 撞地 / 超时起爆，**不能**被子弹打爆、也不会互相撞爆（v3.14.5 删）。
   原因：让别人的机器去引爆我的弹，会造成同一发弹在两端各结算一次、人头算错。
   · 队友身上的火箭 / 落到单位身上的炸弹：都**没有**近炸，只能实碰（4.2 / 5.0） */
export const ROCKET_HIT_R = 4.2;        // 火箭弹对**队友**的接触判定半径（队友不吃近炸）
export const BOMB_HIT_R = 5.0;          // 航空炸弹落到单位（含队友）身上的接触判定半径（炸弹无近炸）
export const MAX_MARKERS = 12;
export const BASE_DMG = 7;
/* 机炮「枪口初速」（相对载机，m/s）。v3.14：520 → 880。
   实际弹速 = 载机速度 + 本值（巡航 95 → ≈975 m/s，约 2.9 马赫）：
   弹道更平、飞行时间短，提前量要得更少；代价是一帧位移更大，
   所以子弹的**撞楼检测改成了沿线采样**（loop.js bulletHitWorldSweep），否则会穿楼。 */
export const BULLET_MUZZLE = 880;

/* ===== 统一弹道模型（v3.18）=====
   物理：弹丸离开枪口时携带的是**枪口相对地面的速度**，所以载具的每一个速度分量都会带走子弹。
   不再把速度拆成「沿弹道 / 垂直弹道」两段，也不按前进、后退、侧飞、俯仰分别写分支：

     v(0) = dir·BULLET_MUZZLE + v_carrier     （伽利略速度叠加，一条矢量）
     dv/dt = -c·|v|·v - g·ŷ                 （真实二次阻力 + 重力，每帧三条公式）
     伤害 = 基础 × (|v_hit| / |v0|)²        （动能 ∝ v²）

   前进时向下射：前进速度自然进入 v(0)，弹道斜向前下；
   后退时前射：v_carrier 反向，合速度降到 840（比悬停 880 慢）；
   飞机巡航：v_carrier = 95·机头方向，合速度 975，与旧版数值一致。
   成千上万种「发射角 × 载具运动」组合，全部由这一条矢量加法 + 同一套积分给出。
   报文只传「枪口初速标量 s」+「载具速度矢量 iv」，接收端按同一公式重建。 */
export const BULLET_INHERIT_MAX = 200;    // 载具速度上限（m/s）：夹紧报文防改包；真实载具最快 170，留 30 余量

/* ===== 子弹自身的弹道衰减（v3.17）=====
   三个独立的物理量，都由「统一模型」自动产生方向差异，不需要按角度分支：
   ① 速度衰减 dv/dt = -c·v² —— 沿弹道方向也掉速，射程变短、飞行时间变长；
   ② 重力下坠 vy -= g·dt —— 水平发射下坠最明显，向上发射先减速再掉头，向下发射加速；
   ③ 伤害衰减（按命中瞬间的速度比平方，动能 ∝ v²）—— 打得越远越"没劲"。
   垂直 / 水平 / 向下三种发射的区别就藏在这两条公式的投影里：
     · 水平：重力全部作用在「下坠」上 → 偏移最大；
     · 向上：重力先吃掉速度 → 爬高越来越慢、水平射程短、几乎看不到横向下坠；
     · 向下：重力与速度同向 → 更快到达，等效射程短、衰减最小。
   阻力用真实二次式 dv/dt = -c·v²（c = ½·ρ·Cd·A/m），不是指数拟合：
   30mm 机炮：m=0.36kg、A=7.07e-4m²、Cd≈0.30、ρ=1.225 → c ≈ 3.6e-4 /m。
   实际弹道（975 m/s 出膛）：600m 速度剩 81%、伤害剩 65%、下坠 2.3m；
   900m 速度剩 72%、伤害剩 52%、下坠 5.8m。 */
export const BULLET_DRAG_Q = 3.6e-4;      // 二次阻力系数（1/m）；作用于整条速度矢量，不含任何方向分支
export const BULLET_GRAVITY = 9.8;        // 子弹重力（m/s²，真实值）
export const BULLET_DMG_MIN = 0.35;       // 伤害衰减下限（远距离不会完全挠痒）

/* ===== 声音传播（v3.14）=====
   声音不再瞬时到达：世界里的事件按「听者到声源距离 ÷ 声速」延迟播放。
   1km 外爆炸 ≈ 3 秒后才听到 —— 用来判断"这声爆炸离我多远"比音量更直观。 */
export const SPEED_OF_SOUND = 343;      // m/s（15℃ 空气；游戏内取整用）
export const SOUND_MAX_DIST = 1500;     // 超过这个距离只留极小音量（不做硬截断，免得完全静音很怪）
export const WHIZ_R = 16;               // 子弹擦身而过的判定半径（米）
export const WHIZ_R_ROCKET = 22;        // 火箭弹掠过的判定半径（更大、声音更低沉）
export const SPEED_MIN = 45, SPEED_MAX = 170;
export const SENS = 0.0022;
// [ANDROID] 触屏灵敏度补丁：读设置面板 localStorage('sd_settings').touchSens（默认 1.7 与网页版一致）
const _sdCfg = (() => { try { return JSON.parse(localStorage.getItem('sd_settings') || '{}'); } catch (e) { return {}; } })();
export const TOUCH_SENS = _sdCfg.touchSens === undefined ? 1.7 : parseFloat(_sdCfg.touchSens);
export const WIN_ROUNDS = 3;

/* ===== 死斗模式（v3.15）=====
   与歼灭（五局三胜）并列的第二种对局规则，由房主在建房时选择：
   · 无限复活、重生无无敌时间；哪队总击杀先到 killTarget 就赢。
   · 死亡到重生之间留一段时间做击杀镜头（跟随击杀者），两者共用 DM_RESPAWN_MS。
   · 重生点由 units.js 的 safeSpawnPos/safeAAGunSpawn 在候选点里挑离敌人最远的，
     防止被人蹲出生点连续对撞。 */
export const DM_RESPAWN_MS = 3000;      // 阵亡 → 重生（同时是击杀镜头时长）
export const DM_KILL_TARGET = 20;       // 默认击杀目标（房主可在建房面板自由调节）
export const DM_KILL_TARGET_MIN = 1;    // 击杀目标下限（房主面板 / cfg 报文都会夹紧）
export const DM_KILL_TARGET_MAX = 100;  // 击杀目标上限（避免手滑填 9999 打不完）
export const DM_KILLCAM_HARD_MS = 6000; // 击杀镜头兜底：重生报文丢失时不至于一直黑在死亡视角
export const MAX_AIM = 0.55;       // 视角最大偏移量（弧度，~31°）
export const TURN_RATE = 2.4;      // 飞机追赶视角的最大转弯速率（rad/s）
export const PITCH_RATE = 1.8;     // 俯仰追赶速率
export const MENU_PITCH_MIN = 0.12, MENU_PITCH_MAX = 1.25;   // 俯角下限防穿地
export const MENU_DIST_MIN = 14, MENU_DIST_MAX = 85;          // 距离下限防贴脸穿模
export const SPLASH_R = 8;        // 溅射半径（米）
export const SPLASH_DMG = 4;      // 溅射基础伤害（距离衰减）
export const HE_AMMO = 30;        // 高爆子弹备弹（每回合）
export const HE_DMG_MULT = 2;     // 伤害倍率
export const HE_SPLASH_MULT = 1.2;// 溅射范围倍率
export const HIT_TOLERANCE = 40;   // 命中位置校验阈值（米）：开火者上报的目标位置与房主权威位置偏差在此内即采信。
// 延迟门槛：连接后测得的 RTT 最小值 ≥ 此值 → 移出房间（v3.12：80 → 150）
// 定 150 的依据：命中判定权在开火者，房主只做 HIT_TOLERANCE(40m) 位置校验。
// 最坏情况偏差 ≈ 机速 170m/s × (单程 RTT 75ms + 远端插值滞后 ~80ms) ≈ 26m < 40m，仍在容差内；
// 80ms 会把跨省宽带（50~80ms）和 4G（60~100ms）的正常玩家直接踢掉。
export const PING_KICK_MS = 150;
export const PING_SAMPLES = 3;     // 延迟采样次数（取最小值：首包受 ICE 建立影响偏大，最小样本最接近真实 RTT）
export const PING_RETRY_ROUNDS = 1;   // 采样不达标时的补采轮数（每轮 1s 后重采 3 次，两轮都不达标才踢）
export const AAGUN_DMG = 4;
export const FUSE_R = 2.6;
export const KILL_FEED_MAX = 5, KILL_FEED_TTL = 6000;
export const VOICE_RATE = 16000, VOICE_CHUNK = 640;
export const AAGUN_BODY_R = 2.65;
