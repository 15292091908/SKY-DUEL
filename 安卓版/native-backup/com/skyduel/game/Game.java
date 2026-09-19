package com.skyduel.game;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Random;

/**
 * 游戏核心：输入 → 飞行 → 射击 → 命中结算 → 回合/五局三胜。
 * 对应 js/main.js 的核心玩法（操控模型、命中判定、回合制、边界与撞毁规则）。
 *
 * 联机 = 房主小世界（与网页版完全同构）：
 *  - 房主：唯一权威（伤害/死亡/回合/比分），20Hz 推送 sync 快照，权威模拟双方子弹；
 *    对加入方上报的子弹做 fid 台账 + hitRep 信任窗口 + dmgReject 延迟否决。
 *  - 加入方：本地预判（打人/被打立即反馈），权威结果由 sync 确认，被否决时 dmgReject 回溯；
 *    回合/比分/胜负全部跟随房主（round/rEnd/matchEnd/sync）。
 *
 * 同步提示：任何玩法规则改动（伤害、回合流程、判定条件）都要同时改这里。
 */
public class Game implements Net.Listener {

    public static final int WIN_ROUNDS = 3;
    public static final float ROUND_DELAY = 3.2f;      // 回合之间停留（与网页版 3200ms 一致）
    public static final float SPAWN_Z = 900f;
    public static final float SENS = 0.0022f;          // 鼠标/拖拽灵敏度（同网页版）
    public static final float TOUCH_SENS = 1.7f;       // 触屏灵敏度（同网页版）

    /** 玩家输入（由 HudView 写入） */
    public static class Input {
        public float aimYaw = 0, aimPitch = 0;    // 视角偏移（准星方向）
        public float steerX = 0;                  // 摇杆左右 → 连续转向
        public float throttleCmd = 0;             // -1 减速 / +1 加速（摇杆上下）
        public boolean firing = false;
        public boolean zoom = false;
        // 每帧累积的拖拽增量（由 HudView 累加，Game 消费后清零）
        public float dragX = 0, dragY = 0;
    }

    public String gameMode = "dogfight";       // dogfight / aavs
    public String mapType = "island";          // island / city / base
    public boolean meIsAAGun = false;
    public boolean foeIsAAGun = false;
    public AAGun meAAGun, foeAAGun;
    public Plane me, foe;
    public Bot bot = new Bot();
    public World world;

    public final Input in;   // 由 HudView 持有并注入（触屏写入、逻辑读取）
    public Sfx sfx;                     // 由 Renderer 注入（可为 null，静音降级）

    // ================= 联机（1v1 · 房主小世界）=================
    public static final int NET_OFF = 0, NET_HOST = 1, NET_GUEST = 2;
    public int netMode = NET_OFF;
    public Net net;
    public volatile String netStatus = "";        // 面板提示
    public volatile boolean netConnected = false;
    public volatile String netOffer = "";    // 房主：邀请码（HUD 复制用）
    public volatile String netAnswer = "";   // 加入方：应答码（HUD 复制用）
    public String hostMap = "island";        // 房主开局地图（联机面板可切换）

    /** peerId：与网页版 Math.random().toString(36).slice(2,12) 同格式 */
    public final String myId = makeId();
    public volatile String foeId = "";               // 对端真实 ID
    public int myTeam = 0;                           // 队伍号 0/1（team0 出生 +Z，team1 出生 -Z）

    private float netSendAcc = 0;
    private int stateSeq = 0;

    // ---- 加入方预判对账（与网页版 firePred/predTotal/lastAuth 同构）----
    private float predSelf = 0, predSelfT = 0, lastAuthSelf = -1;   // 被打预判（显示血 = 权威 - 未确认预判）
    private float predFoe = 0, lastAuthFoe = -1;                    // 打人预判（dmgReject 回溯）
    private final HashMap<Integer, Float> firePred = new HashMap<>();   // fid -> dmg
    private int myFireSeq = 0;

    // ---- 房主 fid 台账（对加入方上报子弹的否决/信任对账）----
    private static final class FireRec { int bidx = -1; boolean fHit = false; }
    private final HashMap<Integer, FireRec> fireBullets = new HashMap<>();
    private final List<long[]> pendingRejects = new ArrayList<>();      // {fid, expireMs}
    private final HashMap<Integer, Long> rejectedFids = new HashMap<>();

    // ---- 击杀台账（kstat，对应网页版 killLedger：房主权威记录"谁击杀了谁"，3s 定向下发）----
    private final HashMap<String, int[]> killLedger = new HashMap<>();  // id -> {击杀k, 阵亡d}
    private String lastDmgFrom = null;                                  // 本次权威伤害来源（死亡时消费，伤害调用后清空）
    private long lastKstatPush = 0;
    public int myKills = 0;                                             // 加入方：kstat 权威覆盖（当前 HUD 暂无击杀计数显示）

    // ---- 网络线程 → 游戏线程：volatile 缓冲 ----
    private volatile boolean pHasState = false, pIsAA = false;
    private volatile float pX, pY, pZ, pQx, pQy, pQz, pQw = 1f, pTy, pTp, pBy, pSp;
    private volatile String pendingSync = null;
    private volatile int pendingRound = -1, pendingREndRn = -1, pendingREndW = 0;
    private volatile int pendingS0 = -1, pendingS1 = -1;
    private volatile boolean pendingMatchEnd = false, matchHostWin = false;
    private volatile int meS0 = -1, meS1 = -1;
    private volatile String pendingCloseReason = null;
    private volatile String pendingHello = null, pendingPeerGone = null;
    private volatile String pendingStartMap = null;         // 'map'/'go'：开局
    private volatile int pendingTeam = -1;                  // 'team'：阵营分配
    private volatile int pendingTeamSlot = 0, pendingHostTeam = 0, pendingHostSlot = 0;
    private volatile String pendingHostId = "", pendingGm = "";
    private volatile boolean pendingPickStart = false, pendingPickReject = false;
    private volatile int pendingPickListTeam = -1, pendingPickListSlot = 0;
    private volatile boolean pendingRematch = false;
    private volatile boolean pendingDied = false;
    // 事件队列（fire/blt/hitRep/dmgReject/envDmg/crash）
    private static final int EV_FIRE = 0, EV_BLT = 1, EV_HITREP = 2, EV_DMGREJ = 3, EV_ENVD = 4, EV_CRASH = 5, EV_KSTAT = 6;
    private static final class NetEv {
        final int type; final String s1, s2; final float[] f; final int i1; final boolean bl;
        NetEv(int type, String s1, String s2, float[] f, int i1, boolean bl) {
            this.type = type; this.s1 = s1; this.s2 = s2; this.f = f; this.i1 = i1; this.bl = bl;
        }
    }
    private final java.util.concurrent.ConcurrentLinkedQueue<NetEv> evq = new java.util.concurrent.ConcurrentLinkedQueue<>();

    /** 房主权威：加入方的血量（房主结算，sync 推送给加入方） */
    public float peerAuthHp = Plane.HP_MAX;
    private boolean peerAlive = true;
    private float netGrace = 0; private int netPendingWinner = 0;   // 0=无 1=我赢 2=我输（宽限期内可被"同归于尽"覆盖）
    private boolean awaitWorld = false;      // 等待 Renderer 按新 mapType 重建世界后开局
    private boolean netStarted = false;      // 本场联机是否已开局（防重复 hello/map/go 二次 beginNetRound）

    // ---- 子弹池（对应 main.js 的 bullets 池）----
    public static final int MAX_BULLETS = 240;
    public final float[] bx = new float[MAX_BULLETS], by = new float[MAX_BULLETS], bz = new float[MAX_BULLETS];
    public final float[] bvx = new float[MAX_BULLETS], bvy = new float[MAX_BULLETS], bvz = new float[MAX_BULLETS];
    public final float[] blife = new float[MAX_BULLETS];
    public final boolean[] bactive = new boolean[MAX_BULLETS];
    public final boolean[] bmine = new boolean[MAX_BULLETS];     // 自己的子弹
    public final boolean[] bbot = new boolean[MAX_BULLETS];      // 练习模式 AI 子弹
    public final int[] bfid = new int[MAX_BULLETS];              // 加入方子弹 fid（房主台账/否决对账）
    public final boolean[] bfHit = new boolean[MAX_BULLETS];     // 房主：该弹已真实命中（信任窗口关闭）
    public final boolean[] btrust = new boolean[MAX_BULLETS];    // 房主：hitRep 信任目标已登记
    public final float[] btrustPx = new float[MAX_BULLETS], btrustPy = new float[MAX_BULLETS], btrustPz = new float[MAX_BULLETS];
    public final float[] btrustDmg = new float[MAX_BULLETS];
    public final boolean[] bsplash = new boolean[MAX_BULLETS];   // 溅射弹（防空车玩法）
    public final boolean[] baa = new boolean[MAX_BULLETS];       // 防空车机枪弹（弹速 520 / 伤害 4）
    private final float[] bpx = new float[MAX_BULLETS], bpy = new float[MAX_BULLETS], bpz = new float[MAX_BULLETS];

    // ---- 爆炸粒子 ----
    public static final int MAX_PARTS = 320;
    public final float[] px = new float[MAX_PARTS], py = new float[MAX_PARTS], pz = new float[MAX_PARTS];
    public final float[] pvx = new float[MAX_PARTS], pvy = new float[MAX_PARTS], pvz = new float[MAX_PARTS];
    public final float[] plife = new float[MAX_PARTS], pmax = new float[MAX_PARTS], psize = new float[MAX_PARTS];
    public final float[] pcr = new float[MAX_PARTS], pcg = new float[MAX_PARTS], pcb = new float[MAX_PARTS];
    public final boolean[] pactive = new boolean[MAX_PARTS];

    // ---- 回合 ----
    public int roundNum = 0;                 // 局号（房主权威；加入方跟随）
    public int s0 = 0, s1 = 0;               // 队伍比分（team0/team1，房主权威）
    public boolean roundOver = false, matchEnded = false, myWin = false;
    private float resetTimer = 0;
    private float rnMismatchT = 0;           // 非房主：sync 局号持续落后本端的看门狗

    /** HUD 用：本方/对方比分（按阵营视角换算，双方显示一致） */
    public int scoreMy() { return myTeam == 0 ? s0 : s1; }
    public int scoreFoe() { return myTeam == 0 ? s1 : s0; }

    // ---- 表现 ----
    public float shake = 0;
    public String banner = "", bannerSub = "";
    public float[] bannerColor = new float[]{0.55f, 0.87f, 1f};
    public float bannerTime = 0;
    public String killMsg = "";
    public float killMsgTime = 0;
    public String warn = "";
    public float fps = 0;
    private float fpsAcc = 0; private int fpsCnt = 0;
    private float dmgAcc = 0, beepAcc = 0;

    // ---- 相机 ----
    public final float[] camPos = new float[]{0, 300, 930};
    public final float[] camTarget = new float[]{0, 280, 880};
    public final float[] camUp = new float[]{0, 1, 0};
    public float camFov = 70f;

    private final Random rnd = new Random();

    public Game(World world, Input input) {
        this.world = world;
        this.in = input;
        me = new Plane(false);
        foe = new Plane(true);
        meAAGun = new AAGun(false);
        foeAAGun = new AAGun(true);
        setupRound();
    }

    /** Renderer 在 GL 线程检测到 mapType 变化后调用（换图） */
    public void setWorld(World w) {
        this.world = w;
    }

    private static String makeId() {
        String cs = "abcdefghijklmnopqrstuvwxyz0123456789";
        Random r = new Random();
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 10; i++) sb.append(cs.charAt(r.nextInt(cs.length())));
        return sb.toString();
    }

    // ============================================================ 出生点（与网页版 spawnPos/aagunSpawnPos 一致）
    private static float[] teamSpawn(int team, float y, float z) {
        return new float[]{0, y, team == 0 ? z : -z, team == 0 ? 0f : (float) Math.PI};
    }

    private float[] aaSpawnOf(int team) {
        float yaw = team == 0 ? 0f : (float) Math.PI;
        if (world.aaSpawns.isEmpty()) return new float[]{0, 0, 0, yaw};
        float[] s = world.aaSpawns.get(0);   // 1v1 固定第一个点位（slot=0）
        return new float[]{s[0], 0, s[2], yaw};
    }

    // ============================================================ 回合流程
    private void nextRound() {
        if (matchEnded) return;
        roundNum++;
        setupRound();
        if (netMode == NET_HOST && net != null) net.sendRound(roundNum);   // 房主权威推送局号
    }

    /** 开局/重置回合：按模式、阵营与地图初始化实体与出生点 */
    private void setupRound() {
        roundOver = false;
        in.firing = false;
        if (netMode != NET_OFF) {
            float y = gameMode.equals("aavs") ? 240f : 280f;
            float zz = gameMode.equals("aavs") ? 520f : SPAWN_Z;
            if (meIsAAGun) meAAGun.reset(aaSpawnOf(myTeam));
            else me.reset(teamSpawn(myTeam, y, zz));
            if (foeIsAAGun) foeAAGun.reset(aaSpawnOf(1 - myTeam));
            else foe.reset(teamSpawn(1 - myTeam, y, zz));
            clearNetReconcile();
            clearBullets();
            in.aimYaw = 0; in.aimPitch = 0; in.steerX = 0; in.dragX = 0; in.dragY = 0;
            banner("第 " + roundNum + " 回合", new float[]{0.87f, 0.95f, 1f}, 1.8f);
            return;
        }
        // ---- 单机/练习 ----
        if (gameMode.equals("aavs") && world.mapType.equals("base")) {
            meIsAAGun = true; foeIsAAGun = false;
            meAAGun.reset(aaSpawnOf(0));
            foe.reset(new float[]{0, 280, -900f, (float) Math.PI});
            foe.alive = true; foe.hp = Plane.HP_MAX;
        } else {
            meIsAAGun = false; foeIsAAGun = false;
            me.reset(new float[]{0, 280, SPAWN_Z, 0});
            foe.reset(new float[]{0, 280, -SPAWN_Z, (float) Math.PI});
        }
        clearBullets();
        in.aimYaw = 0; in.aimPitch = 0; in.steerX = 0; in.dragX = 0; in.dragY = 0;
        banner("第 " + roundNum + " 回合", new float[]{0.87f, 0.95f, 1f}, 1.8f);
    }

    private void clearNetReconcile() {
        predSelf = 0; predSelfT = 0; lastAuthSelf = -1;
        predFoe = 0; lastAuthFoe = -1;
        firePred.clear();
        fireBullets.clear();
        pendingRejects.clear();
        rejectedFids.clear();
        peerAuthHp = foeIsAAGun ? AAGun.HP_MAX : Plane.HP_MAX;
        peerAlive = true;
    }

    /** 回合结算（仅房主有裁决权；加入方只锁操作等 rEnd/rn） */
    private void settleRound(int winTeam) {
        if (roundOver) return;
        if (netMode == NET_GUEST) { roundOver = true; in.firing = false; return; }
        roundOver = true;
        in.firing = false;
        if (winTeam == -1) {
            banner("双方同归于尽", new float[]{1f, 0.88f, 0.54f}, 2.4f);   // 平局双方均不计分
        } else if (winTeam == myTeam) {
            if (myTeam == 0) s0++; else s1++;
            banner("回合胜利", new float[]{0.49f, 0.99f, 0.60f}, 2.4f);
        } else {
            if (winTeam == 0) s0++; else s1++;
            banner("回合失败", new float[]{1f, 0.48f, 0.42f}, 2.4f);
        }
        if (netMode == NET_HOST && net != null) net.sendREnd(roundNum, s0, s1, winTeam);
        if (s0 >= WIN_ROUNDS || s1 >= WIN_ROUNDS) {
            myWin = (myTeam == 0 ? s0 > s1 : s1 > s0);
            if (netMode == NET_HOST && net != null) net.sendMatchEnd(myWin, s0, s1);
            matchEnded = true;
            killMsg = ""; bannerTime = 0;
        } else {
            resetTimer = ROUND_DELAY;
        }
    }

    /** 强制回到干净的单机对局（退出联机、或联机断开后调用） */
    public void resetToSinglePlayer() {
        matchEnded = false; myWin = false;
        s0 = 0; s1 = 0; roundNum = 0;
        resetTimer = 0;
        meIsAAGun = false; foeIsAAGun = false;
        gameMode = "dogfight";
        nextRound();
    }

    /** 联机开局（双方同一时刻：房主 map/go、加入方收到 map/go） */
    private void beginNetRound() {
        matchEnded = false; myWin = false;
        s0 = 0; s1 = 0; roundNum = 0;
        resetTimer = 0; rnMismatchT = 0;
        killLedger.clear(); lastDmgFrom = null; myKills = 0;   // 击杀台账整场累计，开赛清零
        nextRound();
    }

    public void restartMatch() {
        if (!matchEnded) return;
        if (netMode != NET_OFF && net != null) net.sendRematch();   // 与网页版一致：任意端点重赛都广播
        applyRematchLocal();
    }

    private void applyRematchLocal() {
        matchEnded = false; myWin = false;
        s0 = 0; s1 = 0; roundNum = 0;
        resetTimer = 0;
        killLedger.clear(); lastDmgFrom = null; myKills = 0;   // 重赛清零（网页版 resetKillLedger）
        nextRound();
    }

    private void banner(String text, float[] color, float t) {
        banner = text; bannerColor = color; bannerTime = t;
    }

    // ============================================================ 每帧更新
    public void update(float dt) {
        if (dt > 0.05f) dt = 0.05f;

        fpsAcc += dt; fpsCnt++;
        if (fpsAcc >= 0.5f) { fps = fpsCnt / fpsAcc; fpsAcc = 0; fpsCnt = 0; }

        // 等待 Renderer 完成换图后再开局（最多一帧）
        if (awaitWorld && world.mapType.equals(mapType)) {
            awaitWorld = false;
            beginNetRound();
        }

        if (netMode != NET_OFF) updateNet(dt);
        if (!matchEnded) {
            if (!roundOver) updatePlayer(dt);
            if (netMode == NET_OFF) updateBot(dt);
            updateBullets(dt);
        }
        if (netMode != NET_OFF) processNetReconcile(dt);
        updateParticles(dt);
        updateCamera(dt);

        if (bannerTime > 0) bannerTime -= dt;
        if (killMsgTime > 0) killMsgTime -= dt;
        shake = Math.max(0, shake - dt * 2.2f);

        if (resetTimer > 0) {
            resetTimer -= dt;
            if (resetTimer <= 0) nextRound();
        }
    }

    // ---------- 玩家操控 ----------
    private void updatePlayer(float dt) {
        if (meIsAAGun) { updatePlayerAA(dt); return; }
        if (!me.alive) return;
        // 拖拽 → 视角偏移（1:1 无延迟），灵敏度倍率来自设置
        float dx = in.dragX * Settings.sensMul, dy = in.dragY * Settings.sensMul;
        in.dragX = 0; in.dragY = 0;
        in.aimYaw = M4.clamp(in.aimYaw - dx * SENS, -Plane.MAX_AIM, Plane.MAX_AIM);
        in.aimPitch = M4.clamp(in.aimPitch - dy * SENS, -Plane.MAX_AIM, Plane.MAX_AIM);
        // 摇杆左右 → 连续转向
        if (Math.abs(in.steerX) > 0.05f) {
            in.aimYaw = M4.clamp(in.aimYaw - in.steerX * 2.0f * dt, -Plane.MAX_AIM, Plane.MAX_AIM);
        }
        // 摇杆上下 → 油门
        if (in.throttleCmd != 0) {
            me.targetSpeed = M4.clamp(107.5f - in.throttleCmd * 62.5f, Plane.SPEED_MIN, Plane.SPEED_MAX);
        }
        // 飞机追赶视角
        float stepYaw = M4.clamp(in.aimYaw, -Plane.TURN_RATE * dt, Plane.TURN_RATE * dt);
        me.yaw += stepYaw;
        me.yawVel = stepYaw / Math.max(dt, 1e-4f);
        in.aimYaw -= stepYaw;

        float stepPitch = M4.clamp(in.aimPitch, -Plane.PITCH_RATE * dt, Plane.PITCH_RATE * dt);
        me.pitch = M4.clamp(me.pitch + stepPitch, -Plane.MAX_PITCH, Plane.MAX_PITCH);
        in.aimPitch -= stepPitch;

        me.apply(dt);

        // 开火（射速 0.09s，与网页版一致）
        if (in.firing) {
            fireT -= dt;
            if (fireT <= 0) { fireT = 0.09f; fire(me, true); if (sfx != null) sfx.gun(); }
        }
        // 边界 / 限高
        float r = (float) Math.hypot(me.pos[0], me.pos[2]);
        warn = "";
        if (r > world.boundaryWarn) warn = "警告：请返回战斗空域";
        if (me.pos[1] > world.ceiling) warn = "警告：高度过高，立即下降";
        if (!warn.isEmpty() && (beepAcc -= dt) <= 0) { beepAcc = 0.7f; if (sfx != null) sfx.beep(); }
        if (r > world.boundaryHurt || me.pos[1] > world.ceiling + 60) {
            dmgAcc += dt;
            if (dmgAcc > 0.5f) {
                dmgAcc = 0;
                if (netMode == NET_GUEST) {          // 加入方：本地扣血（可致死 → died 上报，同网页版 applyMeDamage(3)）+ 上报房主权威扣血
                    me.hp -= 3f;
                    if (net != null) net.sendEnvDmg(3f);
                    if (me.hp <= 0) selfDestruct();
                } else damageMe(3f, null);
            }
        }
        // 撞海 / 撞地形
        if (me.pos[1] < 3.5f || world.hitTerrain(me.pos, 1.6f)) selfDestruct();
    }

    /** 防空车操控 */
    private void updatePlayerAA(float dt) {
        if (!meAAGun.alive) return;
        if (M4.len(new float[]{meAAGun.pos[0], 0, meAAGun.pos[2]}) > AAGun.MAP_LIMIT) {
            meAAGun.alive = false; explode(meAAGun.turretWorld());
            if (netMode == NET_GUEST && net != null) net.sendDied();
            if (netMode == NET_HOST) recordAuthKill(null, myId);   // 出界自毁：无击杀者
            settleRound(netMode == NET_OFF ? (myTeam == 0 ? 1 : 0) : (1 - myTeam));
            return;
        }
        if (roundOver) return;
        float dx = in.dragX * Settings.sensMul, dy = in.dragY * Settings.sensMul;
        in.dragX = 0; in.dragY = 0;
        meAAGun.turretYaw -= dx * SENS;
        meAAGun.turretPitch = M4.clamp(meAAGun.turretPitch - dy * SENS, AAGun.TURRET_PITCH_MIN, AAGun.TURRET_PITCH_MAX);
        meAAGun.targetSpeed = M4.clamp(-in.throttleCmd * AAGun.AAGUN_SPEED_FWD, AAGun.AAGUN_SPEED_BACK, AAGun.AAGUN_SPEED_FWD);
        if (Math.abs(in.steerX) > 0.05f) meAAGun.bodyYaw += -in.steerX * 1.2f * dt;
        meAAGun.speed += (meAAGun.targetSpeed - meAAGun.speed) * Math.min(1f, dt * 2);
        if (Math.abs(meAAGun.speed) > 0.1f) {
            float[] dir = meAAGun.bodyForward();
            float nx = meAAGun.pos[0] + dir[0] * meAAGun.speed * dt;
            float nz = meAAGun.pos[2] + dir[2] * meAAGun.speed * dt;
            if (!(M4.len(new float[]{nx, 0, nz}) > AAGun.MAP_LIMIT || world.hitTerrain(new float[]{nx, 1, nz}, 2.5f))) {
                meAAGun.pos[0] = nx; meAAGun.pos[2] = nz;
            }
        }
        if (in.firing) {
            fireT -= dt;
            if (fireT <= 0) { fireT = 0.09f; fireAA(meAAGun, true); }
        }
    }

    private float fireT = 0, fireT2 = 0;

    private void updateBot(float dt) {
        if (!foe.alive || !me.alive || roundOver) return;
        bot.update(foe, me, dt);
        foe.apply(dt);
        if (bot.firing && (fireT2 -= dt) <= 0) { fireT2 = 0.12f; fire(foe, false); }
        if (foe.pos[1] < 3.5f || world.hitTerrain(foe.pos, 1.6f)) killFoeOffline();
        float r = (float) Math.hypot(foe.pos[0], foe.pos[2]);
        if (r > world.boundaryHurt) killFoeOffline();
    }

    private void killFoeOffline() {
        if (!foe.alive) return;
        foe.alive = false;
        explode(foe.pos);
        settleRound(0);
    }

    // ---------- 子弹 ----------
    private int allocBullet() {
        for (int i = 0; i < MAX_BULLETS; i++) if (!bactive[i]) return i;
        return -1;
    }

    /** 开火（飞机机炮）。mine=我的子弹；offline 时 foe 的子弹走 bot 分支 */
    private void fire(Plane from, boolean mine) {
        int idx = allocBullet();
        if (idx < 0) return;
        float[] f = from.forward();
        float side = mine ? 1f : 1f;
        bx[idx] = from.pos[0] + f[0] * 3.2f + side * 0.8f;
        by[idx] = from.pos[1] + f[1] * 3.2f - 0.35f;
        bz[idx] = from.pos[2] + f[2] * 3.2f;
        // 轻微散布
        float spread = mine ? 0.0035f : 0.012f;
        float sx = (rnd.nextFloat() - 0.5f) * spread, sy = (rnd.nextFloat() - 0.5f) * spread;
        // 轻微辅助瞄准：若弹道与目标某弱点夹角很小，把方向向弱点方向轻推（仅玩家，可设置关闭）
        float assistAmt = mine ? (Settings.assist == 1 ? 0.35f : (Settings.assist == 2 ? 0.6f : 0f)) : 0f;
        float cone = Settings.assist == 2 ? 0.11f : 0.07f;
        if (assistAmt > 0 && foeAlive()) {
            float[] dir0 = M4.norm(new float[]{f[0] + sx, f[1] + sy, f[2] + sx});
            float bestA = cone; float[] bestDir = null;
            for (int wi = 0; wi < Plane.WEAK.length; wi++) {
                float[] wp = foeWeakWorld(wi);
                float[] d = M4.norm(M4.sub(wp, new float[]{bx[idx], by[idx], bz[idx]}));
                float ang = (float) Math.acos(M4.clamp(M4.dot(dir0, d), -1f, 1f));
                if (ang < bestA) { bestA = ang; bestDir = d; }
            }
            if (bestDir != null) {
                float t = assistAmt * (1f - bestA / cone);
                float[] nd = M4.norm(M4.add(M4.mul(dir0, 1f - t), M4.mul(bestDir, t)));
                f = nd; sx = sy = 0;
            }
        }
        bvx[idx] = (f[0] + sx) * Plane.BULLET_SPEED;
        bvy[idx] = (f[1] + sy) * Plane.BULLET_SPEED;
        bvz[idx] = (f[2] + sx) * Plane.BULLET_SPEED;
        bpx[idx] = bx[idx]; bpy[idx] = by[idx]; bpz[idx] = bz[idx];
        blife[idx] = Plane.BULLET_LIFE;
        bactive[idx] = true; bmine[idx] = mine; bbot[idx] = !mine && netMode == NET_OFF;
        bfid[idx] = 0; bfHit[idx] = false; btrust[idx] = false;
        baa[idx] = false;
        bsplash[idx] = gameMode.equals("aavs");   // 防空车玩法机炮带溅射（网页版：gamemode === 'aavs'，单机/联机一致）
        netSendFire(idx, M4.norm(new float[]{bvx[idx], bvy[idx], bvz[idx]}));
    }

    /** 防空车开火（对应 main.js fireGunAAGun：双管交替 + 散布 + 弹速 520 + 伤害 4） */
    private void fireAA(AAGun ag, boolean mine) {
        int idx = allocBullet();
        if (idx < 0) return;
        float[] mp2 = ag.turretWorld();
        float[] md = ag.turretForward().clone();
        float[] mp = new float[]{mp2[0] + md[0] * 3.2f, mp2[1] + md[1] * 3.2f, mp2[2] + md[2] * 3.2f};
        // 散布
        float sp = AAGun.GUN_SPREAD;
        md[0] += (rnd.nextFloat() - 0.5f) * sp; md[1] += (rnd.nextFloat() - 0.5f) * sp; md[2] += (rnd.nextFloat() - 0.5f) * sp;
        // 辅助瞄准（轻微）
        if (mine && foeAlive()) {
            float[] toFoe = M4.norm(M4.sub(foePos(), mp));
            float ang = (float) Math.acos(M4.clamp(M4.dot(md, toFoe), -1f, 1f));
            float cone = 0.09f, amt = Settings.assist == 1 ? 0.4f : (Settings.assist == 2 ? 0.65f : 0f);
            if (ang < cone && M4.dist(foePos(), mp) < 900f) {
                float t = amt * (1f - ang / cone);
                float[] nd = M4.norm(M4.add(M4.mul(md, 1f - t), M4.mul(toFoe, t)));
                md[0] = nd[0]; md[1] = nd[1]; md[2] = nd[2];
            }
        }
        bx[idx] = mp[0]; by[idx] = mp[1]; bz[idx] = mp[2];
        bvx[idx] = md[0] * AAGun.BULLET_SPEED; bvy[idx] = md[1] * AAGun.BULLET_SPEED; bvz[idx] = md[2] * AAGun.BULLET_SPEED;
        bpx[idx] = mp[0]; bpy[idx] = mp[1]; bpz[idx] = mp[2];
        blife[idx] = Plane.BULLET_LIFE;
        bactive[idx] = true; bmine[idx] = mine; bbot[idx] = false;
        bfid[idx] = 0; bfHit[idx] = false; btrust[idx] = false;
        baa[idx] = true;
        bsplash[idx] = false;   // 与网页版一致：防空车机枪弹无溅射（spawnBullet 未传 splash）
        netSendFire(idx, md);
    }

    /** 联机子弹上报/广播（对应网页版：房主 blt 广播 / 加入方 fire 上报） */
    private void netSendFire(int idx, float[] dir) {
        if (netMode == NET_OFF || net == null || !netConnected) return;
        float ox = bx[idx], oy = by[idx], oz = bz[idx];
        float dx = dir[0], dy = dir[1], dz = dir[2];
        float sp = baa[idx] ? AAGun.BULLET_SPEED : Plane.BULLET_SPEED;
        float dm = baa[idx] ? AAGun.AAGUN_DMG : Plane.BASE_DMG;
        if (netMode == NET_HOST) {
            net.sendBlt(ox, oy, oz, dx, dy, dz, "", sp, dm, bsplash[idx]);
        } else {
            int fid = ++myFireSeq;
            bfid[idx] = fid;                      // 本地预判命中时对账用
            net.sendFire(ox, oy, oz, dx, dy, dz, fid, sp, dm, bsplash[idx]);
        }
    }

    private float bulletDmgOf(int idx) { return baa[idx] ? AAGun.AAGUN_DMG : Plane.BASE_DMG; }

    /** 房主：按加入方上报的开火生成权威子弹（main.js fire 处理） */
    private void spawnPeerBullet(String sender, float ox, float oy, float oz, float dx, float dy, float dz,
                                 int fid, float speed, float dmg, boolean splash) {
        if (roundOver || fid <= 0) return;
        int idx = allocBullet();
        if (idx < 0) return;
        float[] dir = M4.norm(new float[]{dx, dy, dz});
        bx[idx] = ox; by[idx] = oy; bz[idx] = oz;
        bvx[idx] = dir[0] * speed; bvy[idx] = dir[1] * speed; bvz[idx] = dir[2] * speed;
        bpx[idx] = ox; bpy[idx] = oy; bpz[idx] = oz;
        blife[idx] = Plane.BULLET_LIFE;
        bactive[idx] = true; bmine[idx] = false; bbot[idx] = false;
        bfid[idx] = fid; bfHit[idx] = false; btrust[idx] = false;
        baa[idx] = speed < 540f;
        bsplash[idx] = splash;
        bulletAuthDmg[idx] = dmg;
        FireRec rec = new FireRec(); rec.bidx = idx;
        fireBullets.put(fid, rec);            // 开火对账：等 hitRep 声称命中 / 未命中延迟否决
    }

    /** 加入方：按房主广播生成对方子弹（本地显示 + 被打预判） */
    private void spawnHostBullet(float ox, float oy, float oz, float dx, float dy, float dz,
                                 float speed, float dmg, boolean splash) {
        int idx = allocBullet();
        if (idx < 0) return;
        float[] dir = M4.norm(new float[]{dx, dy, dz});
        bx[idx] = ox; by[idx] = oy; bz[idx] = oz;
        bvx[idx] = dir[0] * speed; bvy[idx] = dir[1] * speed; bvz[idx] = dir[2] * speed;
        bpx[idx] = ox; bpy[idx] = oy; bpz[idx] = oz;
        blife[idx] = Plane.BULLET_LIFE;
        bactive[idx] = true; bmine[idx] = false; bbot[idx] = false;
        bfid[idx] = 0; bfHit[idx] = false; btrust[idx] = false;
        baa[idx] = speed < 540f;
        bsplash[idx] = splash;
        bulletAuthDmg[idx] = dmg;
    }

    private final float[] bulletAuthDmg = new float[MAX_BULLETS];   // 网络子弹携带的伤害（发射方参数）

    private void updateBullets(float dt) {
        long nowMs = System.currentTimeMillis();
        for (int i = 0; i < MAX_BULLETS; i++) {
            if (!bactive[i]) continue;
            bpx[i] = bx[i]; bpy[i] = by[i]; bpz[i] = bz[i];
            bx[i] += bvx[i] * dt; by[i] += bvy[i] * dt; bz[i] += bvz[i] * dt;
            blife[i] -= dt;
            boolean isNet = netMode != NET_OFF;

            // 生命周期/落地/撞世界 → 消亡（房主：fid 弹未命中 → 进入延迟否决队列）
            if (blife[i] <= 0 || by[i] < 0.2f || (isNet && world.hitTerrain(new float[]{bx[i], by[i], bz[i]}, 0.4f))) {
                if (bsplash[i] && by[i] < 1.2f && by[i] > -1f) splashBoom(bx[i], Math.max(0.3f, by[i]), bz[i], i, nowMs);
                bulletDied(i);
                continue;
            }

            float[] a = {bpx[i], bpy[i], bpz[i]}, b = {bx[i], by[i], bz[i]};

            // ---- 房主：信任命中检测（宽容延迟补偿，对应 main.js b.trust 分支）----
            if (netMode == NET_HOST && !bmine[i] && btrust[i] && !bfHit[i] && myAlive() && !roundOver) {
                float[] tgPos = myEntPos();
                if (tgPos != null && M4.dist(tgPos, new float[]{btrustPx[i], btrustPy[i], btrustPz[i]}) < 60f
                        && M4.dist(tgPos, b) < 22f) {
                    bfHit[i] = true; bactive[i] = false;
                    fireBullets.remove(bfid[i]);
                    spawnSparks(bx[i], by[i], bz[i], 10, new float[]{1f, 0.8f, 0.45f});
                    trustDamageMe(btrustDmg[i]);
                    continue;
                }
            }

            // ---- 我的子弹：打对方 ----
            if (bmine[i] && foeAlive()) {
                int w = foeIsAAGun ? foeAAGun.hitTest(a, b) : foe.hitTest(a, b);
                if (w >= 0) {
                    bactive[i] = false;
                    float dmg = Math.round(bulletDmgOf(i) * weakMult(foeIsAAGun, w));
                    hitFlash = 1f;
                    hitMsg = "命中" + weakName(foeIsAAGun, w) + " ×" + (int) weakMult(foeIsAAGun, w);
                    hitMsgTime = 1.1f;
                    spawnSparks(bx[i], by[i], bz[i], 10, new float[]{1f, 0.8f, 0.45f});
                    if (netMode == NET_GUEST) {
                        // 非房主：本地预判扣血 + hitRep 上报（房主信任/否决对账）
                        predFoe += dmg;
                        if (bfid[i] > 0) firePred.put(bfid[i], (float) dmg);
                        if (net != null && bfid[i] > 0) {
                            float[] hp3 = foeIsAAGun ? foeAAGun.pos : foe.pos;
                            net.sendHitRep(bfid[i], foeId, hp3[0], hp3[1], hp3[2], dmg);
                        }
                    } else if (netMode == NET_HOST) {
                        hostDamagePeer((int) dmg, myId);   // 房主权威结算（击杀归因=房主）
                    } else if (foeIsAAGun) {
                        foeAAGun.hp -= dmg;
                        if (foeAAGun.hp <= 0) { foeAAGun.alive = false; explode(foeAAGun.pos); settleRound(0); }
                    } else {
                        foe.hp -= dmg;
                        if (foe.hp <= 0) killFoeOffline();
                    }
                    continue;
                }
                // 溅射近失（防空车）：我的溅射弹在对方车旁爆炸（距离衰减，同网页版 applySplashToAAGun）
                if (bsplash[i] && foeIsAAGun && M4.dist(foeAAGun.pos, b) < 16f) {
                    bactive[i] = false;
                    float sd = M4.dist(foeAAGun.pos, b);
                    int dmg = Math.max(2, Math.round(6f * (1f - sd / 16f)));
                    bfHit[i] = true;   // 真实溅射命中 → 关闭否决窗口（main.js b.fHit = true）
                    spawnSparks(bx[i], by[i], bz[i], 12, new float[]{1f, 0.7f, 0.4f});
                    if (netMode == NET_GUEST) {
                        predFoe += dmg;
                        if (bfid[i] > 0) {
                            firePred.put(bfid[i], (float) dmg);
                            if (net != null) net.sendHitRep(bfid[i], foeId, foeAAGun.pos[0], foeAAGun.pos[1], foeAAGun.pos[2], dmg);
                        }
                    } else if (netMode == NET_HOST) {
                        hostDamagePeer(dmg, myId);   // 房主权威结算（击杀归因=房主）
                    } else {
                        foeAAGun.hp -= dmg;
                        if (foeAAGun.hp <= 0) { foeAAGun.alive = false; explode(foeAAGun.pos); settleRound(0); }
                    }
                    continue;
                }
            }

            // ---- 对方/机器人的子弹：打我 ----
            if (!bmine[i] && myAlive()) {
                int w = meIsAAGun ? meAAGun.hitTest(a, b) : me.hitTest(a, b);
                if (w >= 0) {
                    bactive[i] = false;
                    float dmg = Math.round((bbot[i] ? Plane.BASE_DMG : bulletAuthDmg[i]) * weakMult(meIsAAGun, w));
                    spawnSparks(bx[i], by[i], bz[i], 8, new float[]{1f, 0.6f, 0.5f});
                    hitFlash = 1f;
                    hitMsg = "被击中" + weakName(meIsAAGun, w); hitMsgTime = 1.1f;
                    if (netMode == NET_GUEST) {
                        // 被打预判：只做即时反馈，死亡由房主 sync 权威判定
                        predSelf += dmg; predSelfT = nowMs;
                        if (meIsAAGun) meAAGun.hp -= dmg; else me.hp -= dmg;
                    } else {
                        if (netMode == NET_HOST) lastDmgFrom = foeId;   // 击杀归因=开火者（fid 弹）
                        damageMe(dmg, null);
                        lastDmgFrom = null;
                    }
                    // 房主：加入方子弹真实命中 → 关闭信任窗口/撤销待否决（main.js b.fHit = true，防 hitRep 双结算）
                    if (netMode == NET_HOST && bfid[i] > 0) {
                        bfHit[i] = true;
                        fireBullets.remove(bfid[i]);
                        for (int k = pendingRejects.size() - 1; k >= 0; k--)
                            if (pendingRejects.get(k)[0] == bfid[i]) pendingRejects.remove(k);
                    }
                    continue;
                }
                // 溅射波及（防空车被溅射 / 地面爆炸）
                if (bsplash[i] && meIsAAGun && M4.dist(meAAGun.pos, b) < 16f) {
                    bactive[i] = false;
                    int dmg = Math.max(2, Math.round(6f * 0.8f));
                    spawnSparks(bx[i], by[i], bz[i], 12, new float[]{1f, 0.7f, 0.4f});
                    if (netMode == NET_GUEST) { predSelf += dmg; predSelfT = nowMs; meAAGun.hp -= dmg; }
                    else {
                        if (netMode == NET_HOST && bfid[i] > 0) { bfHit[i] = true; lastDmgFrom = foeId; }
                        damageMe(dmg, null);
                        lastDmgFrom = null;
                    }
                    if (netMode == NET_HOST && bfid[i] > 0) {
                        bfHit[i] = true;
                        fireBullets.remove(bfid[i]);
                        for (int k = pendingRejects.size() - 1; k >= 0; k--)
                            if (pendingRejects.get(k)[0] == bfid[i]) pendingRejects.remove(k);
                    }
                }
            }
        }
    }

    /** 房主：fid 弹消亡（未命中任何目标）→ 延迟否决队列（等 220ms 收 hitRep） */
    private void bulletDied(int i) {
        bactive[i] = false;
        if (netMode == NET_HOST && !bmine[i] && bfid[i] > 0 && !bfHit[i]) {
            fireBullets.remove(bfid[i]);
            pendingRejects.add(new long[]{bfid[i], System.currentTimeMillis() + 220});
        }
    }

    /** 落地/近失爆炸溅射（防空车玩法）。归属与网页版一致：我的弹只溅射对方车；对方弹只溅射我的车 */
    private void splashBoom(float x, float y, float z, int i, long nowMs) {
        spawnSparks(x, y, z, 14, new float[]{1f, 0.8f, 0.45f});
        if (!bsplash[i]) return;
        if (bmine[i] && foeIsAAGun && M4.dist(foeAAGun.pos, new float[]{x, 0, z}) < 16f) {
            float sd = M4.dist(foeAAGun.pos, new float[]{x, 0, z});
            int dmg = Math.max(2, Math.round(6f * (1f - sd / 16f)));   // 距离衰减（同网页版 applySplashToAAGun）
            bfHit[i] = true;   // 溅射命中 → 不进否决队列
            if (netMode == NET_GUEST) {
                predFoe += dmg;
                if (bfid[i] > 0) {
                    firePred.put(bfid[i], (float) dmg);
                    if (net != null) net.sendHitRep(bfid[i], foeId, foeAAGun.pos[0], foeAAGun.pos[1], foeAAGun.pos[2], dmg);
                }
            } else if (netMode == NET_HOST) { hostDamagePeer(dmg, myId); }
            else { foeAAGun.hp -= dmg; if (foeAAGun.hp <= 0) { foeAAGun.alive = false; explode(foeAAGun.pos); settleRound(0); } }
        }
        if (!bmine[i] && meIsAAGun && M4.dist(meAAGun.pos, new float[]{x, 0, z}) < 16f) {
            int dmg = Math.max(2, Math.round(6f * 0.8f));
            if (netMode == NET_GUEST) { predSelf += dmg; predSelfT = nowMs; meAAGun.hp -= dmg; }
            else {
                if (netMode == NET_HOST && bfid[i] > 0) { bfHit[i] = true; lastDmgFrom = foeId; }
                damageMe(dmg, null);
                lastDmgFrom = null;
            }
        }
    }

    /** 每帧网络对账（对应 main.js processNetReconcile） */
    private void processNetReconcile(float dt) {
        long now = System.currentTimeMillis();
        if (netMode == NET_HOST) {
            for (int i = pendingRejects.size() - 1; i >= 0; i--) {
                long[] r = pendingRejects.get(i);
                if (now >= r[1]) {
                    pendingRejects.remove(i);
                    rejectedFids.put((int) r[0], now);   // 记入已否决表：迟到的 hitRep 忽略（防双结算）
                    if (net != null) net.sendDmgReject((int) r[0]);
                }
            }
        } else {
            // 被打预判 400ms 未确认 → 回滚（sync 到达后自愈）
            if (predSelf > 0 && now - predSelfT > 400) {
                if (meIsAAGun) meAAGun.hp += predSelf; else me.hp += predSelf;
                predSelf = 0;
            }
        }
    }

    private void damageMe(float dmg, String part) {
        if (!myAlive() || roundOver) return;
        if (meIsAAGun) meAAGun.hp -= dmg; else me.hp -= dmg;   // 只结算当前实体（防空车 HP 120 ≠ 飞机 HP 100）
        shake = Math.min(0.9f, shake + 0.35f);
        if (part != null) { hitMsg = "被击中" + part; hitMsgTime = 1.1f; hitFlash = 1f; }
        if ((meIsAAGun ? meAAGun.hp : me.hp) <= 0) {
            explode(myEntPos());
            if (netMode != NET_OFF) {
                if (netMode == NET_HOST) { recordAuthKill(lastDmgFrom, myId); lastDmgFrom = null; }
                netGrace = 0.6f; netPendingWinner = 2;   // 联机：等宽限期，可能被判平局
            }
            else settleRound(1);
        }
    }

    /** 房主：信任结算（hitRep 声称命中 → 对我方实体直接扣血；击杀归因=上报者=加入方） */
    private void trustDamageMe(float dmg) {
        if (!myAlive() || roundOver) return;
        if (meIsAAGun) meAAGun.hp -= dmg; else me.hp -= dmg;
        shake = Math.min(0.9f, shake + 0.35f);
        if ((meIsAAGun ? meAAGun.hp : me.hp) <= 0) {
            explode(myEntPos());
            recordAuthKill(foeId, myId);
            netGrace = 0.6f; netPendingWinner = 2;
        }
    }

    // ---- 击杀台账（对应网页版 recordAuthKill / lastDmgFrom）----
    private int[] ledgerOf(String id) {
        int[] e = killLedger.get(id);
        if (e == null) { e = new int[2]; killLedger.put(id, e); }
        return e;
    }

    /** 房主：记录一次权威死亡（killer 为空 = 环境/自毁/掉线，只记阵亡） */
    private void recordAuthKill(String killer, String victim) {
        if (killer != null && !killer.isEmpty()) ledgerOf(killer)[0]++;
        ledgerOf(victim)[1]++;
    }

    /** 房主：权威扣加入方血量（带击杀归因，对应网页版 lastDmgFrom = x; applyPeerDamage(); lastDmgFrom = null） */
    private void hostDamagePeer(int dmg, String killer) {
        lastDmgFrom = killer;
        peerAuthHp = Math.max(0, peerAuthHp - dmg);
        checkPeerDead();
        lastDmgFrom = null;
    }

    /** 房主：加入方阵亡（权威） */
    private void checkPeerDead() {
        if (!peerAlive) return;
        if (peerAuthHp <= 0) {
            peerAlive = false;
            if (foeIsAAGun) foeAAGun.alive = false; else foe.alive = false;
            recordAuthKill(lastDmgFrom, foeId);
            lastDmgFrom = null;
            explode(foePos());
            netGrace = 0.6f; netPendingWinner = 1;   // 宽限 0.6s，另一侧同死则判平局
        }
    }

    private void selfDestruct() {
        if (!me.alive) return;
        me.alive = false;
        explode(me.pos);
        if (netMode == NET_GUEST) { if (net != null) net.sendDied(); roundOver = true; in.firing = false; return; }
        if (netMode == NET_HOST) { recordAuthKill(lastDmgFrom, myId); lastDmgFrom = null; netGrace = 0.6f; netPendingWinner = 2; return; }
        settleRound(1);
    }

    private boolean foeAlive() {
        return foeIsAAGun ? foeAAGun.alive : foe.alive;
    }

    private boolean myAlive() {
        return meIsAAGun ? meAAGun.alive : me.alive;
    }

    private float[] foePos() { return foeIsAAGun ? foeAAGun.pos : foe.pos; }

    private float[] myEntPos() { return meIsAAGun ? meAAGun.pos : me.pos; }

    private static float weakMult(boolean aa, int w) { return aa ? AAGun.WEAK[w].mult : Plane.WEAK[w].mult; }
    private static String weakName(boolean aa, int w) { return aa ? AAGun.WEAK[w].name : Plane.WEAK[w].name; }

    private float[] foeWeakWorld(int wi) {
        return foeIsAAGun ? aaWeakWorld(foeAAGun, wi) : foe.weakWorld(wi);
    }

    private static float[] aaWeakWorld(AAGun ag, int wi) {
        AAGun.Weak wp = AAGun.WEAK[wi];
        float ox = wp.ox, oz = wp.oz;
        if (wp.onTurret) {
            float cy = (float) Math.cos(ag.turretYaw - ag.bodyYaw), sy = (float) Math.sin(ag.turretYaw - ag.bodyYaw);
            float nx = ox * cy + oz * sy;
            oz = -ox * sy + oz * cy;
            ox = nx;
        }
        return new float[]{ag.pos[0] + ox, ag.pos[1] + wp.oy, ag.pos[2] + oz};
    }

    public float hitFlash = 0;
    public String hitMsg = "";
    public float hitMsgTime = 0;

    // ---------- 粒子 ----------
    private void explode(float[] pos) {
        if (pos == null) return;
        shake = 1.1f;
        if (sfx != null) sfx.explosion();
        for (int n = 0; n < 110; n++) {
            int i = -1;
            for (int k = 0; k < MAX_PARTS; k++) if (!pactive[k]) { i = k; break; }
            if (i < 0) return;
            float sp = 12f + rnd.nextFloat() * 48f;
            float tx = rnd.nextFloat() * 2 - 1, ty = rnd.nextFloat() * 2 - 1, tz = rnd.nextFloat() * 2 - 1;
            float l = (float) Math.sqrt(tx * tx + ty * ty + tz * tz) + 1e-3f;
            px[i] = pos[0]; py[i] = pos[1]; pz[i] = pos[2];
            pvx[i] = tx / l * sp; pvy[i] = ty / l * sp + 6f; pvz[i] = tz / l * sp;
            pmax[i] = 0.7f + rnd.nextFloat() * 1.6f;
            plife[i] = pmax[i];
            psize[i] = 2.2f + rnd.nextFloat() * 5.5f;
            boolean smoke = rnd.nextFloat() < 0.35f;
            if (smoke) { pcr[i] = 0.30f; pcg[i] = 0.29f; pcb[i] = 0.28f; }
            else { pcr[i] = 1f; pcg[i] = 0.55f + rnd.nextFloat() * 0.3f; pcb[i] = 0.16f; }
            pactive[i] = true;
        }
    }

    private void spawnSparks(float x, float y, float z, int count, float[] color) {
        for (int n = 0; n < count; n++) {
            int i = -1;
            for (int k = 0; k < MAX_PARTS; k++) if (!pactive[k]) { i = k; break; }
            if (i < 0) return;
            px[i] = x; py[i] = y; pz[i] = z;
            pvx[i] = (rnd.nextFloat() - 0.5f) * 26; pvy[i] = (rnd.nextFloat() - 0.5f) * 26; pvz[i] = (rnd.nextFloat() - 0.5f) * 26;
            pmax[i] = 0.28f + rnd.nextFloat() * 0.3f; plife[i] = pmax[i];
            psize[i] = 0.8f + rnd.nextFloat() * 1.4f;
            pcr[i] = color[0]; pcg[i] = color[1]; pcb[i] = color[2];
            pactive[i] = true;
        }
    }

    private void updateParticles(float dt) {
        if (hitFlash > 0) hitFlash = Math.max(0, hitFlash - dt * 3.2f);
        for (int i = 0; i < MAX_PARTS; i++) {
            if (!pactive[i]) continue;
            plife[i] -= dt;
            if (plife[i] <= 0) { pactive[i] = false; continue; }
            float drag = Math.max(0f, 1f - 1.25f * dt);
            pvx[i] *= drag; pvy[i] = pvy[i] * drag - 7f * dt; pvz[i] *= drag;
            px[i] += pvx[i] * dt; py[i] += pvy[i] * dt; pz[i] += pvz[i] * dt;
        }
    }

    private void clearBullets() {
        for (int i = 0; i < MAX_BULLETS; i++) bactive[i] = false;
    }

    // ---------- 相机（第三人称：跟随"视角方向"，随飞机滚转）----------
    private void updateCamera(float dt) {
        float vyaw = me.yaw + in.aimYaw;
        float vpitch = M4.clamp(me.pitch + in.aimPitch, -Plane.MAX_PITCH, Plane.MAX_PITCH);
        float cp = (float) Math.cos(vpitch), sp = (float) Math.sin(vpitch);
        float cy = (float) Math.cos(vyaw), sy = (float) Math.sin(vyaw);
        float[] viewDir = new float[]{-sy * cp, sp, -cy * cp};

        float[] anchor = myEntPos();
        float dist = in.zoom ? 12.5f : 21f;
        float[] up = (!meIsAAGun && me.alive) ? me.up() : new float[]{0, 1, 0};
        float[] want = new float[]{
                anchor[0] - viewDir[0] * dist + up[0] * 4.6f,
                anchor[1] - viewDir[1] * dist + up[1] * 4.6f,
                anchor[2] - viewDir[2] * dist + up[2] * 4.6f
        };
        float k = 1f - (float) Math.exp(-9.0 * dt);
        for (int i = 0; i < 3; i++) camPos[i] += (want[i] - camPos[i]) * k;
        if (shake > 0) {
            camPos[0] += (rnd.nextFloat() - 0.5f) * shake * 1.6f;
            camPos[1] += (rnd.nextFloat() - 0.5f) * shake * 1.6f;
            camPos[2] += (rnd.nextFloat() - 0.5f) * shake * 1.6f;
        }
        if (camPos[1] < 6f) camPos[1] = 6f;     // 相机不穿地

        camTarget[0] = anchor[0] + viewDir[0] * 70f;
        camTarget[1] = anchor[1] + viewDir[1] * 70f;
        camTarget[2] = anchor[2] + viewDir[2] * 70f;
        System.arraycopy(up, 0, camUp, 0, 3);
        camFov += ((in.zoom ? 42f : 70f) - camFov) * Math.min(1f, dt * 6f);
    }

    /** 敌机在屏幕上的方向与距离（HUD 标记用） */
    public float[] foeDir() { return M4.norm(M4.sub(foePos(), me.pos)); }
    public float foeDist() { return M4.dist(foePos(), myEntPos()); }
    public float[] viewDir() {
        float vyaw = me.yaw + in.aimYaw;
        float vpitch = M4.clamp(me.pitch + in.aimPitch, -Plane.MAX_PITCH, Plane.MAX_PITCH);
        float cp = (float) Math.cos(vpitch), sp = (float) Math.sin(vpitch);
        float cy = (float) Math.cos(vyaw), sy = (float) Math.sin(vyaw);
        return new float[]{-sy * cp, sp, -cy * cp};
    }

    // ============================================================ 联机 1v1
    /** 创建房间（房主） */
    public void startHost() {
        stopNet(null);
        netMode = NET_HOST;
        net = new Net();
        net.setMyId(myId);
        netOffer = ""; netAnswer = "";
        netStatus = "正在生成邀请码…";
        net.host(this);
    }

    /** 加入房间（贴入房主的邀请码 SDP） */
    public void startJoin(String offerCode) {
        stopNet(null);
        netMode = NET_GUEST;
        net = new Net();
        net.setMyId(myId);
        netStatus = "正在解析邀请码…";
        net.join(this);
        net.pasteOffer(offerCode);
    }

    public void stopNet(String reason) {
        if (net != null) net.close();
        net = null;
        netMode = NET_OFF;
        netConnected = false;
        pHasState = false;
        netGrace = 0; netPendingWinner = 0;
        awaitWorld = false;
        netStarted = false;
        killLedger.clear(); lastDmgFrom = null; myKills = 0;
        pendingRound = -1; pendingREndRn = -1; pendingMatchEnd = false; pendingCloseReason = null;
        pendingSync = null; pendingStartMap = null; pendingTeam = -1; pendingHello = null;
        evq.clear();
        if (reason != null) { netStatus = reason; banner(reason, new float[]{1f, 0.55f, 0.5f}, 3f); }
        else netStatus = "";
        resetToSinglePlayer();
    }

    /** 房主：贴入对手的应答码 */
    public void acceptAnswer(String code) { if (net != null) net.pasteAnswer(code); }

    /** 复制文本到剪贴板（由 HUD 的复制按钮调用） */
    public void copyText(String text) { if (net != null) net.copyText(text); }

    // ================= 四元数 ↔ 欧拉（网页版 group 为 YXZ 欧拉序；q 数组 [x,y,z,w]） =================
    private static float[] eulerToQ(float yaw, float pitch) {
        float cy = (float) Math.cos(yaw / 2), sy = (float) Math.sin(yaw / 2);
        float cp = (float) Math.cos(pitch / 2), sp = (float) Math.sin(pitch / 2);
        // q = qY(yaw) * qX(pitch)
        return new float[]{cy * sp, sy * cp, -sy * sp, cp * cy};   // [x, y, z, w]
    }

    private static float qToYaw(float qx, float qy, float qz, float qw) {
        return (float) Math.atan2(2f * (qx * qz + qw * qy), 1f - 2f * (qx * qx + qy * qy));
    }

    private static float qToPitch(float qx, float qy, float qz, float qw) {
        return (float) Math.asin(M4.clamp(2f * (qw * qx - qy * qz), -1f, 1f));
    }

    /** 联机每帧：状态收发、事件消费、房主裁决、非房主跟随 */
    private void updateNet(float dt) {
        long nowMs = System.currentTimeMillis();

        // ---- 1) 20Hz 状态 ----
        netSendAcc += dt;
        if (net != null && netConnected && netSendAcc >= 0.05f) {
            netSendAcc = 0;
            if (netMode == NET_GUEST) {
                if (meIsAAGun) net.sendUpdAA(meAAGun.pos, meAAGun.turretYaw, meAAGun.turretPitch, meAAGun.bodyYaw, meAAGun.speed);
                else net.sendUpdPlane(me.pos, eulerToQ(me.yaw, me.pitch), me.speed);
            } else {
                net.sendSync(buildSyncLst(), s0, s1, roundNum, roundOver);
            }
        }

        // ---- 1b) 房主：击杀台账定向下发（3s 一次，对应网页版 pushWorldSync 内的 kstat 推送）----
        if (netMode == NET_HOST && net != null && netConnected && nowMs - lastKstatPush > 3000) {
            lastKstatPush = nowMs;
            int[] mine = ledgerOf(myId), theirs = ledgerOf(foeId);
            net.sendKstat(theirs[0], theirs[1]);   // 对方收到的是对方自己的 {击杀, 阵亡}
            myKills = mine[0];
        }

        // ---- 2) 对方位姿应用（网络目标 → 插值）----
        if (pHasState) {
            float k = 1f - (float) Math.exp(-14f * dt);
            float[] anchor = foePos();
            anchor[0] += (pX - anchor[0]) * k;
            anchor[1] += (pY - anchor[1]) * k;
            anchor[2] += (pZ - anchor[2]) * k;
            if (pIsAA != foeIsAAGun) { /* 实体类型不一致（正常不会发生） */ }
            if (foeIsAAGun) {
                foeAAGun.turretYaw = lerpAngle(foeAAGun.turretYaw, pTy, k);
                foeAAGun.turretPitch += (pTp - foeAAGun.turretPitch) * k;
                foeAAGun.bodyYaw = lerpAngle(foeAAGun.bodyYaw, pBy, k);
            } else {
                float ty = qToYaw(pQx, pQy, pQz, pQw), tp = qToPitch(pQx, pQy, pQz, pQw);
                foe.yaw = lerpAngle(foe.yaw, ty, k);
                foe.pitch += (tp - foe.pitch) * k;
                foe.roll = 0;
                if (foe.alive) foe.propSpin -= dt * (12f + foe.speed * 0.4f);
            }
        }

        // ---- 3) sync 快照（加入方）：权威位置/血量/存活/比分/局号 ----
        String sync = pendingSync;
        if (sync != null && netMode == NET_GUEST) {
            pendingSync = null;
            applySync(sync);
        }

        // ---- 4) 事件队列 ----
        NetEv ev;
        while ((ev = evq.poll()) != null) {
            float[] f = ev.f;
            switch (ev.type) {
                case EV_FIRE:   // 房主：加入方开火 → 权威子弹
                    if (netMode == NET_HOST)
                        spawnPeerBullet(ev.s1, f[0], f[1], f[2], f[3], f[4], f[5], ev.i1, f[6], f[7], ev.bl);
                    break;
                case EV_BLT:    // 加入方：房主子弹 → 本地显示 + 被打预判（自己的回声弹过滤）
                    if (netMode == NET_GUEST && (ev.s2 == null || !ev.s2.equals(myId)))
                        spawnHostBullet(f[0], f[1], f[2], f[3], f[4], f[5], f[6], f[7], ev.bl);
                    break;
                case EV_HITREP: // 房主：命中上报
                    if (netMode == NET_HOST) applyHitRep(ev.i1, f[0], f[1], f[2], Math.round(f[3]));
                    break;
                case EV_DMGREJ: // 加入方：否决回溯
                    if (netMode == NET_GUEST) {
                        Float d = firePred.remove(ev.i1);
                        if (d != null) {
                            predFoe = Math.max(0, predFoe - d);
                            refreshFoeDispHp();
                        }
                    }
                    break;
                case EV_ENVD:   // 房主：环境伤害上报（无击杀者）
                    if (netMode == NET_HOST && peerAlive && !roundOver) {
                        float dm = Math.max(1, Math.min(20, Math.round(f[0])));
                        hostDamagePeer(Math.round(dm), null);
                    }
                    break;
                case EV_CRASH:  // 房主：碰撞上报（轻撞互扣 / 同归于尽）
                    if (netMode == NET_HOST && !roundOver) {
                        if (ev.bl) {   // fatal：双方同亡（互为击杀者）
                            if (myAlive()) { explode(myEntPos()); me.hp = 0; meAAGun.hp = 0; recordAuthKill(foeId, myId); }
                            lastDmgFrom = myId;
                            if (peerAlive) { peerAuthHp = 0; checkPeerDead(); }
                            lastDmgFrom = null;
                            netGrace = 0.6f; netPendingWinner = -1;
                        } else {
                            float dm = Math.max(1, Math.min(40, Math.round(f[0])));
                            if (myAlive()) { lastDmgFrom = foeId; damageMe(dm, null); lastDmgFrom = null; }
                            if (peerAlive) hostDamagePeer(Math.round(dm), foeId);
                        }
                    }
                    break;
                case EV_KSTAT:  // 加入方：权威击杀台账覆盖（3s 一次，预判计数最终以台账为准）
                    if (netMode == NET_GUEST) myKills = Math.max(0, Math.round(f[0]));
                    break;
            }
        }

        // ---- 5) 大厅/流程消息 ----
        if (pendingHello != null && netMode == NET_HOST && !netStarted) {
            String guest = pendingHello; pendingHello = null;
            netStarted = true;
            foeId = guest;
            myTeam = 0;
            meIsAAGun = false; foeIsAAGun = false;
            gameMode = "dogfight";
            mapType = hostMap;
            if (net != null) {
                net.sendTeam(1, 0, 0, 0, "dogfight");
                net.sendRoster(myId, 0, guest, 1);
                net.sendMap(hostMap);
            }
            netStatus = "对手已加入 · 开局 " + mapName(hostMap);
            awaitWorld = true;   // 等 Renderer 换图后 beginNetRound
        }
        if (pendingTeam >= 0 && netMode == NET_GUEST) {
            myTeam = pendingTeam; pendingTeam = -1;
            myTeamSlot(pendingTeamSlot, pendingHostTeam, pendingHostSlot, pendingHostId, pendingGm);
        }
        if (pendingPickStart && netMode == NET_GUEST) {   // aavs 房主流程：自动选防空车阵营
            pendingPickStart = false;
            if (net != null) net.sendPick(1);
        }
        if (pendingPickReject && netMode == NET_GUEST) {  // 满员 → 换一边
            pendingPickReject = false;
            if (net != null) net.sendPick(0);
        }
        if (pendingPickListTeam >= 0 && netMode == NET_GUEST) {
            myTeam = pendingPickListTeam; pendingPickListTeam = -1;
            applyGamemodeAavs();
            netStatus = "阵营已分配 · 等待开局…";
            if (net != null) net.sendReady();
        }
        if (pendingStartMap != null && netMode == NET_GUEST && !netStarted) {
            String map = pendingStartMap; pendingStartMap = null;
            netStarted = true;
            mapType = map;
            awaitWorld = true;
            netStatus = "对战开始！";
        }
        if (pendingDied && netMode == NET_HOST) {   // 加入方自毁上报（无击杀者，网页版同构）
            pendingDied = false;
            if (peerAlive && !roundOver) { lastDmgFrom = null; peerAuthHp = 0; checkPeerDead(); }
        }
        if (pendingRound >= 0 && netMode == NET_GUEST) {
            int rn = pendingRound; pendingRound = -1;
            if (rn >= 0 && rn != roundNum) {
                if (rn < roundNum) {           // 房主开了新的一场（重赛）
                    matchEnded = false; myWin = false; s0 = 0; s1 = 0;
                }
                roundNum = rn;
                setupRound();
            }
        }
        if (pendingREndRn >= 0 && netMode == NET_GUEST) {
            int rn = pendingREndRn, w = pendingREndW;
            int s0v = pendingS0, s1v = pendingS1;
            pendingREndRn = -1; pendingS0 = -1; pendingS1 = -1;
            if (rn >= roundNum) {
                roundNum = rn;
                if (s0v >= 0) { s0 = s0v; s1 = s1v; }
                roundOver = true; in.firing = false;
                if (w == -1) banner("双方同归于尽", new float[]{1f, 0.88f, 0.54f}, 2.4f);
                else if (w == myTeam) banner("回合胜利", new float[]{0.49f, 0.99f, 0.60f}, 2.4f);
                else banner("回合失败", new float[]{1f, 0.48f, 0.42f}, 2.4f);
            }
        }
        if (pendingMatchEnd && netMode == NET_GUEST) {
            pendingMatchEnd = false;
            if (meS0 >= 0) { s0 = meS0; s1 = meS1; }
            matchEnded = true; roundOver = true; in.firing = false;
            myWin = (myTeam == 0 ? s0 > s1 : s1 > s0);
        }
        if (pendingRematch) {
            pendingRematch = false;
            if (matchEnded) applyRematchLocal();
        }
        if (pendingPeerGone != null) {
            pendingPeerGone = null;
            if (netMode == NET_HOST) { /* 房主通过 onClosed 感知掉线 */ }
        }
        String close = pendingCloseReason;
        if (close != null) {
            pendingCloseReason = null;
            netStatus = close;
            boolean inMatch = !matchEnded && roundNum > 0 && netConnected;
            if (net != null) { net.close(); net = null; }
            netConnected = false;
            netMode = NET_OFF;
            if (inMatch) {                       // 对局中断线：对手掉线 → 判我胜（与网页版 endMatchIfFoesGone 一致）
                matchEnded = true; roundOver = true; in.firing = false; myWin = true;
                banner("对手已掉线 · 比赛结束", new float[]{1f, 0.88f, 0.54f}, 3f);
            } else {
                banner(close, new float[]{1f, 0.55f, 0.5f}, 3f);
                resetToSinglePlayer();
            }
        }

        // ---- 6) 房主宽限期裁决（支持"同归于尽"判平局）----
        if (netMode == NET_HOST && netGrace > 0 && !roundOver) {
            netGrace -= dt;
            if (netGrace <= 0) {
                netGrace = 0;
                boolean meDead = !myAlive(), foeDead = !peerAlive;
                int winner = netPendingWinner; netPendingWinner = 0;
                if (meDead && foeDead) settleRound(-1);
                else if (winner == 1) settleRound(myTeam);
                else if (winner == 2) settleRound(1 - myTeam);
                else if (winner == -1) settleRound(-1);
            }
        }
    }

    private int myTeamSlotSlot;   // 保留 slot（1v1 恒 0）
    private void myTeamSlot(int slot, int hostTeam, int hostSlot, String hostId, String gm) {
        myTeamSlotSlot = slot;
        foeId = hostId;
        gameMode = (gm != null && !gm.isEmpty()) ? gm : "dogfight";
        applyGamemodeAavs();
        if (gameMode.equals("aavs")) mapType = "base";
        netStatus = "阵营已分配（" + (myTeam == 0 ? "蓝方" : "红方") + "）· 等待房主开局…";
    }

    private void applyGamemodeAavs() {
        boolean aavs = gameMode.equals("aavs");
        meIsAAGun = aavs && myTeam == 1;
        foeIsAAGun = aavs && myTeam == 0;
    }

    /** 房主：hitRep 处理（对应 main.js case 'hitRep'） */
    private void applyHitRep(int fid, float px, float py, float pz, int dmg) {
        if (fid <= 0 || roundOver) return;
        int dm = Math.max(1, Math.min(40, dmg));
        if (rejectedFids.containsKey(fid)) return;   // 该弹已被否决回溯 → 忽略
        for (int i = pendingRejects.size() - 1; i >= 0; i--)
            if (pendingRejects.get(i)[0] == fid) pendingRejects.remove(i);   // 撤销待否决
        FireRec rec = fireBullets.get(fid);
        if (rec != null && rec.bidx >= 0 && bactive[rec.bidx] && !bfHit[rec.bidx]) {
            btrust[rec.bidx] = true;   // 子弹仍在飞行：登记信任目标，到达上报点附近时按上报结算
            btrustPx[rec.bidx] = px; btrustPy[rec.bidx] = py; btrustPz[rec.bidx] = pz;
            btrustDmg[rec.bidx] = dm;
        } else if (rec == null || !bfHit[rec.bidx]) {
            trustDamageMe(dm);         // 220ms 窗口内的迟到 hitRep → 宽容结算
        }
    }

    /** 房主 20Hz 快照：我 + 加入方（与网页版 pushWorldSync 字段一致） */
    private String buildSyncLst() {
        try {
            JSONArray lst = new JSONArray();
            if (meIsAAGun) {
                lst.put(new JSONObject()
                        .put("id", myId)
                        .put("p", ja3(meAAGun.pos[0], meAAGun.pos[1], meAAGun.pos[2]))
                        .put("hp", Math.max(0, Math.round(meAAGun.hp)))
                        .put("al", meAAGun.alive)
                        .put("ty", r2(meAAGun.turretYaw)).put("tp", r2(meAAGun.turretPitch)).put("by", r2(meAAGun.bodyYaw)));
            } else {
                float[] q = eulerToQ(me.yaw, me.pitch);
                lst.put(new JSONObject()
                        .put("id", myId)
                        .put("p", ja3(me.pos[0], me.pos[1], me.pos[2]))
                        .put("q", ja4(q[0], q[1], q[2], q[3]))
                        .put("hp", Math.max(0, Math.round(me.hp)))
                        .put("al", me.alive));
            }
            if (foeIsAAGun) {
                lst.put(new JSONObject()
                        .put("id", foeId)
                        .put("p", ja3(foeAAGun.pos[0], foeAAGun.pos[1], foeAAGun.pos[2]))
                        .put("hp", Math.max(0, Math.round(peerAuthHp)))
                        .put("al", peerAlive)
                        .put("ty", r2(foeAAGun.turretYaw)).put("tp", r2(foeAAGun.turretPitch)).put("by", r2(foeAAGun.bodyYaw)));
            } else {
                float[] q = eulerToQ(foe.yaw, foe.pitch);
                lst.put(new JSONObject()
                        .put("id", foeId)
                        .put("p", ja3(foe.pos[0], foe.pos[1], foe.pos[2]))
                        .put("q", ja4(q[0], q[1], q[2], q[3]))
                        .put("hp", Math.max(0, Math.round(peerAuthHp)))
                        .put("al", peerAlive));
            }
            return lst.toString();
        } catch (Throwable t) { return "[]"; }
    }

    private static JSONArray ja3(float x, float y, float z) throws JSONException {
        JSONArray a = new JSONArray();
        a.put(r2(x)); a.put(r2(y)); a.put(r2(z));
        return a;
    }

    private static JSONArray ja4(float x, float y, float z, float w) throws JSONException {
        JSONArray a = new JSONArray();
        a.put(r2(x)); a.put(r2(y)); a.put(r2(z)); a.put(r2(w));
        return a;
    }

    private static double r2(float v) { return Math.round(v * 100d) / 100d; }

    /** 加入方：应用房主权威快照（对应 main.js onPeerState 'sync' 分支） */
    private void applySync(String line) {
        try {
            JSONObject d = new JSONObject(line);
            JSONArray lst = d.optJSONArray("lst");
            long nowMs = System.currentTimeMillis();
            if (lst != null) {
                for (int i = 0; i < lst.length(); i++) {
                    JSONObject it = lst.optJSONObject(i);
                    if (it == null) continue;
                    String id = it.optString("id", "");
                    JSONArray p = it.optJSONArray("p");
                    if (p == null || p.length() < 3) continue;
                    float ex = (float) p.optDouble(0), ey = (float) p.optDouble(1), ez = (float) p.optDouble(2);
                    int hp = it.optInt("hp", 100);
                    boolean al = it.optBoolean("al", true);
                    if (id.equals(myId)) {
                        // 自己的血量/存活以房主小世界为准（本地预判只做即时反馈）
                        if (meIsAAGun) {
                            float lastA = lastAuthSelf < 0 ? hp : lastAuthSelf;
                            predSelf = Math.max(0, predSelf - Math.max(0, lastA - hp));
                            lastAuthSelf = hp;
                            meAAGun.hp = hp - predSelf;
                            if (!al && meAAGun.alive && !roundOver) {
                                meAAGun.alive = false;
                                float[] dp = meAAGun.turretWorld(); dp[1] += 1;
                                explode(dp);
                            }
                        } else {
                            float lastA = lastAuthSelf < 0 ? hp : lastAuthSelf;
                            predSelf = Math.max(0, predSelf - Math.max(0, lastA - hp));
                            lastAuthSelf = hp;
                            me.hp = hp - predSelf;
                            if (!al && me.alive && !roundOver) { me.alive = false; explode(me.pos); }
                        }
                    } else {
                        // 对方（房主实体）：位置 + 权威血量 + 预判对账
                        if (foeIsAAGun) {
                            foeAAGun.pos[0] = ex; foeAAGun.pos[1] = ey; foeAAGun.pos[2] = ez;
                            float ty = (float) it.optDouble("ty", foeAAGun.turretYaw);
                            float tp = (float) it.optDouble("tp", foeAAGun.turretPitch);
                            float by = (float) it.optDouble("by", foeAAGun.bodyYaw);
                            foeAAGun.turretYaw = ty; foeAAGun.turretPitch = tp; foeAAGun.bodyYaw = by;
                            float lastA = lastAuthFoe < 0 ? hp : lastAuthFoe;
                            predFoe = Math.max(0, predFoe - Math.max(0, lastA - hp));
                            lastAuthFoe = hp;
                            foeAAGun.hp = hp - predFoe;
                            if (!al && foeAAGun.alive && !roundOver) { foeAAGun.alive = false; explode(foeAAGun.pos); }
                        } else {
                            foe.pos[0] = ex; foe.pos[1] = ey; foe.pos[2] = ez;
                            JSONArray q = it.optJSONArray("q");
                            if (q != null && q.length() >= 4) {
                                pQx = (float) q.optDouble(0); pQy = (float) q.optDouble(1);
                                pQz = (float) q.optDouble(2); pQw = (float) q.optDouble(3);
                                foe.yaw = qToYaw(pQx, pQy, pQz, pQw);
                                foe.pitch = qToPitch(pQx, pQy, pQz, pQw);
                            }
                            float lastA = lastAuthFoe < 0 ? hp : lastAuthFoe;
                            predFoe = Math.max(0, predFoe - Math.max(0, lastA - hp));
                            lastAuthFoe = hp;
                            foe.hp = hp - predFoe;
                            if (!al && foe.alive && !roundOver) { foe.alive = false; explode(foe.pos); }
                        }
                    }
                }
            }
            // 比分/局号/结束标志：state 通道乱序，旧回合的迟到大快照不得回退新状态
            int rn = d.optInt("rn", -1);
            boolean staleSnap = rn >= 0 && rn < roundNum;
            if (staleSnap) {
                if (rnMismatchT == 0) rnMismatchT = nowMs;
                else if (nowMs - rnMismatchT > 1500) {   // 看门狗自愈：本端局号超前 → 以房主为准重新对齐
                    rnMismatchT = 0;
                    matchEnded = false; myWin = false;
                    s0 = d.optInt("s0", 0); s1 = d.optInt("s1", 0);
                    roundNum = rn;
                    setupRound();
                    return;
                }
            } else {
                rnMismatchT = 0;
                if (d.has("s0")) { s0 = d.optInt("s0", s0); s1 = d.optInt("s1", s1); }
                if (rn >= 0 && rn > roundNum) { roundNum = rn; setupRound(); }
                if (d.has("over")) {
                    boolean over = d.optBoolean("over", false);
                    if (over != roundOver) { roundOver = over; if (over) in.firing = false; }
                }
            }
        } catch (Throwable ignored) {}
    }

    private void refreshFoeDispHp() {
        if (lastAuthFoe < 0) return;
        if (foeIsAAGun) foeAAGun.hp = lastAuthFoe - predFoe;
        else foe.hp = lastAuthFoe - predFoe;
    }

    private static String mapName(String m) {
        if ("city".equals(m)) return "都市";
        if ("base".equals(m)) return "军事基地";
        return "海岛";
    }

    private static float lerpAngle(float a, float b, float t) {
        float d = b - a;
        while (d > Math.PI) d -= (float) (Math.PI * 2);
        while (d < -Math.PI) d += (float) (Math.PI * 2);
        return a + d * t;
    }

    // ================= Net.Listener（网络线程 → 只写 volatile 缓冲）=================
    @Override public void onConnected(boolean asHost) {
        netConnected = true;
        if (asHost) {
            netStatus = "对手通道已建立，等待对手加入…";
        } else {
            netStatus = "已连接，等待房主分配阵营…";
            if (net != null) net.sendHello();   // 与网页版一致：通道打开即上报真实 ID
        }
    }
    @Override public void onOfferCode(String code) { netOffer = code; netStatus = "邀请码已生成，点「复制邀请码」发给对手"; }
    @Override public void onAnswerCode(String code) { netAnswer = code; netStatus = "应答码已生成，点「复制应答码」发给房主"; }
    @Override public void onStatus(String text) { netStatus = text; }
    @Override public void onClosed(String reason) { pendingCloseReason = reason; }

    @Override public void onUpd(boolean isAA, float x, float y, float z, float qx, float qy, float qz, float qw,
                                float ty, float tp, float by, float sp) {
        pIsAA = isAA; pX = x; pY = y; pZ = z;
        pQx = qx; pQy = qy; pQz = qz; pQw = qw;
        pTy = ty; pTp = tp; pBy = by; pSp = sp;
        pHasState = true;
        // 房主权威死亡判定：撞海 / 防空车出海
        if (netMode == NET_HOST && peerAlive && !roundOver) {
            if (!isAA && y <= 0.9f) { peerAuthHp = 0; checkPeerDead(); }
            if (isAA && Math.hypot(x, z) > 430f) { peerAuthHp = 0; checkPeerDead(); }
        }
    }

    @Override public void onSyncJson(String json) { pendingSync = json; }

    @Override public void onFire(String sender, float ox, float oy, float oz, float dx, float dy, float dz,
                                 int fid, float speed, float dmg, boolean splash) {
        evq.add(new NetEv(EV_FIRE, sender, null,
                new float[]{ox, oy, oz, dx, dy, dz, speed, dmg}, fid, splash));
    }

    @Override public void onBlt(String from, float ox, float oy, float oz, float dx, float dy, float dz,
                                float speed, float dmg, boolean splash) {
        evq.add(new NetEv(EV_BLT, null, from,
                new float[]{ox, oy, oz, dx, dy, dz, speed, dmg}, 0, splash));
    }

    @Override public void onHitRep(String sender, int fid, String targetId, float px, float py, float pz, float dmg) {
        evq.add(new NetEv(EV_HITREP, null, null, new float[]{px, py, pz, dmg}, fid, false));
    }

    @Override public void onDmgReject(int fid) { evq.add(new NetEv(EV_DMGREJ, null, null, new float[0], fid, false)); }

    @Override public void onEnvDmg(String sender, float dmg) { evq.add(new NetEv(EV_ENVD, null, null, new float[]{dmg}, 0, false)); }

    @Override public void onDied(String id) { pendingDied = true; }

    @Override public void onCrash(String sender, String target, float dmg, boolean fatal) {
        evq.add(new NetEv(EV_CRASH, null, null, new float[]{dmg}, 0, fatal));
    }

    @Override public void onREnd(int rn, int s0v, int s1v, int w) {
        pendingREndRn = rn; pendingS0 = s0v; pendingS1 = s1v; pendingREndW = w;
    }

    @Override public void onRound(int rn) { pendingRound = rn; }

    @Override public void onMatchEnd(int s0v, int s1v, boolean hostWin) {
        meS0 = s0v; meS1 = s1v; matchHostWin = hostWin; pendingMatchEnd = true;
    }

    @Override public void onRematch() { pendingRematch = true; }

    @Override public void onKstat(int k, int d) {   // 加入方：权威击杀台账 → 事件队列消费
        evq.add(new NetEv(EV_KSTAT, null, null, new float[]{k, d}, 0, false));
    }

    @Override public void onHello(String id) { pendingHello = id; }

    @Override public void onTeam(int team, int slot, int hostTeam, int hostSlot, String hostId, String gamemode) {
        pendingTeam = team; pendingTeamSlot = slot; pendingHostTeam = hostTeam; pendingHostSlot = hostSlot;
        pendingHostId = hostId; pendingGm = gamemode;
    }

    @Override public void onStart(String map) { pendingStartMap = map; }

    @Override public void onPeerGone(String id) { pendingPeerGone = id; }

    @Override public void onPickStart() { pendingPickStart = true; }

    @Override public void onPickList(int team, int slot) { pendingPickListTeam = team; pendingPickListSlot = slot; }

    @Override public void onPickReject() { pendingPickReject = true; }
}
