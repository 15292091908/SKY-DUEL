// js/config.js — 《苍穹对决》全局可调参数（v3.3 从 main.js 抽出）
// 所有游戏性数值集中在此：改数值不必翻主文件。导出后各模块按需 import。

export const GAME_VERSION = 'v3.10.6';
export const MODE_SIZE = { 'net': 2 };
export const SPAWN_Z = 900;
export const AAGUN_HP = 150;
export const ROCKET_SPEED = 260;        // 初速（RPG 风格：比机炮慢、肉眼可追）
export const ROCKET_BOOST_RANGE = 500; // 动力段：出膛后先平飞 500m（无重力不减速，沿发射方向直线），之后才下坠（v3.4 用户要求）
export const ROCKET_DRAG = 0.12;        // 动能衰减率（每秒 12%，耗尽后坠海；仅无动力段生效）
export const ROCKET_GRAVITY = 38;       // 重力下坠（m/s²；2026-10-06 用户反馈"火箭弹没有下坠"后增加）
export const ROCKET_LIFE = 9;           // 寿命（秒）
export const ROCKET_PROX_R = 10;        // 近炸引信触发半径（米）
export const ROCKET_BLAST_R = 40;       // 爆炸波及半径（与房主命中校验阈值一致，保证波及伤害能通过校验）
export const ROCKET_DMG = 150;          // 主目标伤害（飞机 HP 100 → 一击致命）
export const ROCKETS_PER_AAGUN = 1;     // 每辆车备弹
export const MAX_MARKERS = 12;
export const BASE_DMG = 7;
export const SPEED_MIN = 45, SPEED_MAX = 170;
export const SENS = 0.0022;
export const TOUCH_SENS = 1.7;
export const WIN_ROUNDS = 3;
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
export const PING_KICK_MS = 80;    // 延迟门槛：连接后测得的 RTT 最小值 ≥ 此值 → 直接移出房间
export const PING_SAMPLES = 3;     // 延迟采样次数（取最小值：首包受 ICE 建立影响偏大，最小样本最接近真实 RTT）
export const AAGUN_DMG = 4;
export const FUSE_R = 2.6;
export const KILL_FEED_MAX = 5, KILL_FEED_TTL = 6000;
export const VOICE_RATE = 16000, VOICE_CHUNK = 640;
export const AAGUN_BODY_R = 2.65;
