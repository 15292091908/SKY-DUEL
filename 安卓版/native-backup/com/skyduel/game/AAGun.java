package com.skyduel.game;

/**
 * 防空车：履带底盘 + 旋转炮塔 + 双管高射机枪。
 * 对应网页版 js/aagun.js（buildAAGun / makeAAGun / applyAAGun / forwardOfTurret / forwardOfBody）。
 *
 * 同步提示：HP 120、弱点（弹药箱×2 / 炮塔×1.3 / 车体×1）、散布 0.016、弹速 520、伤害 4
 * 必须与 aagun.js / main.js 保持一致。
 */
public class AAGun {

    public static final float HP_MAX = 120f;
    public static final float AAGUN_DMG = 4f;
    public static final float AAGUN_SPEED_FWD = 12f;    // 前进 12 单位/s ≈ 43km/h
    public static final float AAGUN_SPEED_BACK = -6f;
    public static final float BODY_TURN = 1.05f;        // 车体转向 rad/s（键位 A/D）
    public static final float GUN_SPREAD = 0.016f;      // 机枪散布
    public static final float BULLET_SPEED = 520f;
    public static final float TURRET_PITCH_MIN = -0.15f, TURRET_PITCH_MAX = 1.35f;
    public static final float MAP_LIMIT = 393f;         // 出岛报废半径

    /** 弱点：offset 相对车体；onTurret=true 时跟随炮塔旋转 */
    public static final class Weak {
        public final String name;
        public final float ox, oy, oz, r, mult;
        public final boolean onTurret;
        public Weak(String name, float ox, float oy, float oz, float r, float mult, boolean onTurret) {
            this.name = name; this.ox = ox; this.oy = oy; this.oz = oz; this.r = r; this.mult = mult; this.onTurret = onTurret;
        }
    }

    public static final Weak[] WEAK = {
            new Weak("弹药箱", 0f, 2.75f, 0.1f, 1.25f, 2.0f, true),
            new Weak("炮塔",   0f, 2.6f, -0.2f, 1.55f, 1.3f, true),
            new Weak("车体",   0f, 1.35f, 0f, 2.65f, 1.0f, false),
    };

    // ---- 模型 ----
    public Gfx.Mesh bodyMesh, darkMesh, armorMesh, trackMesh, gunMesh;

    // ---- 状态 ----
    public float[] pos = new float[]{0, 0, 0};
    public float bodyYaw = 0, turretYaw = 0, turretPitch = 0.35f;
    public float speed = 0, targetSpeed = 0;
    public float hp = HP_MAX;
    public boolean alive = true;
    public boolean gunSide = false;

    public AAGun(boolean foe) { buildMeshes(foe); }

    public void reset(float[] spawn) {
        pos = new float[]{spawn[0], 0, spawn[2]};
        bodyYaw = spawn[3]; turretYaw = spawn[3]; turretPitch = 0.35f;
        speed = 0; targetSpeed = 0;
        hp = HP_MAX; alive = true; gunSide = false;
    }

    /** 炮塔朝向单位向量 */
    public float[] turretForward() {
        float cp = (float) Math.cos(turretPitch), sp = (float) Math.sin(turretPitch);
        float cy = (float) Math.cos(turretYaw), sy = (float) Math.sin(turretYaw);
        return new float[]{-sy * cp, sp, -cy * cp};
    }

    /** 车体前进方向（水平） */
    public float[] bodyForward() {
        return new float[]{-(float) Math.sin(bodyYaw), 0, -(float) Math.cos(bodyYaw)};
    }

    /** 应用到模型矩阵（车体 + 炮塔独立旋转 + 枪管俯仰） */
    public float[][] models() {
        float[] body = M4.mul(M4.translate(pos[0], pos[1], pos[2]), M4.rotYXZ(0, bodyYaw, 0));
        // 炮塔：先随车体，再相对旋转（turretYaw - bodyYaw）
        float[] t = M4.translate(pos[0], pos[1], pos[2]);
        float[] tb = M4.mul(t, M4.rotYXZ(0, bodyYaw, 0));
        float[] turret = M4.mul(tb, M4.rotYXZ(0, turretYaw - bodyYaw, 0));
        float[] guns = M4.mul(turret, M4.rotYXZ(turretPitch, 0, 0));
        return new float[][]{body, turret, guns};
    }

    /** 开火：双管交替 + 散布（对应 main.js fireGunAAGun） */
    public float[] muzzle(float[] outPos, float[] outDir) {
        gunSide = !gunSide;
        float mx = gunSide ? 0.3f : -0.3f;
        // 枪口世界坐标：车体位置 + 炮塔旋转 → (mx, 0.78, -3.1) + 炮塔俯仰
        float cy = (float) Math.cos(turretYaw), sy = (float) Math.sin(turretYaw);
        float cp = (float) Math.cos(turretPitch), sp = (float) Math.sin(turretPitch);
        float lx = mx, ly = 0.78f, lz = -3.1f;
        // 先俯仰（绕 X）
        float ly2 = ly * cp - lz * sp, lz2 = ly * sp + lz * cp;
        // 再炮塔 yaw（绕 Y）
        float lx2 = lx * cy + lz2 * sy, lz3 = -lx * sy + lz2 * cy;
        // 再车体 yaw
        float bx = lx2 * (float) Math.cos(bodyYaw) + lz3 * (float) Math.sin(bodyYaw);
        float bz = -lx2 * (float) Math.sin(bodyYaw) + lz3 * (float) Math.cos(bodyYaw);
        outPos[0] = pos[0] + bx; outPos[1] = pos[1] + ly2 + 2.2f; outPos[2] = pos[2] + bz;
        outDir[0] = turretForward()[0]; outDir[1] = turretForward()[1]; outDir[2] = turretForward()[2];
        return outDir;
    }

    public float[] turretWorld() {
        return new float[]{pos[0], pos[1] + 2.2f, pos[2]};
    }

    /** 线段 vs 弱点球 */
    public int hitTest(float[] a, float[] b) {
        float cy = (float) Math.cos(turretYaw - bodyYaw), sy = (float) Math.sin(turretYaw - bodyYaw);
        for (int i = 0; i < WEAK.length; i++) {
            Weak wp = WEAK[i];
            float ox = wp.ox, oz = wp.oz;
            if (wp.onTurret) {       // 炮塔弱点跟随炮塔相对旋转
                float nx = ox * cy + oz * sy;
                oz = -ox * sy + oz * cy;
                ox = nx;
            }
            float[] c = new float[]{pos[0] + ox, pos[1] + wp.oy, pos[2] + oz};
            // 线段-球体最近点
            float[] ab = M4.sub(b, a);
            float ab2 = M4.dot(ab, ab);
            float t = ab2 < 1e-6f ? 0 : M4.clamp(M4.dot(M4.sub(c, a), ab) / ab2, 0f, 1f);
            float[] pt = M4.add(a, M4.mul(ab, t));
            if (M4.dist(pt, c) <= wp.r + 0.3f) return i;
        }
        return -1;
    }

    // ================= 模型构建（对应 buildAAGun，精简至可辨识主体）=================
    private void buildMeshes(boolean foe) {
        float bodyTint = foe ? 0.16f : 0f;   // 敌方偏红
        Gfx.Builder body = new Gfx.Builder();
        body.box(0, 1.0f, 0, 3.3f, 0.85f, 4.9f);                  // 底盘
        body.box(0, 1.8f, 0, 2.9f, 0.75f, 4.0f);                  // 上层结构
        // 前倾斜甲板
        body.quad(new float[]{-1.55f, 1.0f, -2.3f}, new float[]{1.55f, 1.0f, -2.3f},
                new float[]{1.55f, 2.05f, -2.56f}, new float[]{-1.55f, 2.05f, -2.56f});
        body.box(0, 1.5f, -2.45f, 3.1f, 0.06f, 0.5f);
        // 侧裙板
        body.box(-1.86f, 1.15f, 0, 0.16f, 0.72f, 4.7f);
        body.box(1.86f, 1.15f, 0, 0.16f, 0.72f, 4.7f);
        // 车尾油桶 + 拖钩
        body.box(1.2f, 1.95f, 2.1f, 0.34f, 0.5f, 0.2f);
        body.box(0, 0.8f, 2.6f, 0.5f, 0.18f, 0.3f);
        bodyMesh = body.build();

        Gfx.Builder dark = new Gfx.Builder();
        dark.box(0, 1.3f, 0.45f, 0.72f, 0.16f, 0.72f);            // 舱盖
        dark.box(0, 1.55f, -0.55f, 0.1f, 1.0f, 0.1f);             // 雷达杆
        dark.cylinder(0, 2.05f, -0.55f, 0.52f, 0.52f, 0.07f, 10); // 火控雷达盘
        dark.box(-0.8f, 1.9f, 0.9f, 0.07f, 2.0f, 0.07f);          // 通信天线
        // 双管机枪（沿 -Z）
        dark.box(-0.3f, 0.78f, -1.35f, 0.18f, 0.18f, 3.2f);
        dark.box(0.3f, 0.78f, -1.35f, 0.18f, 0.18f, 3.2f);
        dark.box(-0.3f, 0.78f, -2.9f, 0.34f, 0.34f, 0.5f);        // 消焰器
        dark.box(0.3f, 0.78f, -2.9f, 0.34f, 0.34f, 0.5f);
        // 弹链箱
        dark.box(-0.62f, 0.55f, 0.1f, 0.52f, 0.42f, 0.65f);
        dark.box(0.62f, 0.55f, 0.1f, 0.52f, 0.42f, 0.65f);
        darkMesh = dark.build();

        Gfx.Builder armor = new Gfx.Builder();
        armor.box(0, 0.55f, 1.15f, 1.5f, 0.55f, 0.75f);           // 后部储物篮
        armor.box(0, 0.85f, -0.55f, 1.3f, 0.75f, 0.1f);           // 枪盾
        armor.cylinder(1.08f, 0.6f, 0.2f, 0.3f, 0.3f, 0.06f, 10); // 检修舱门
        armorMesh = armor.build();

        Gfx.Builder trk = new Gfx.Builder();
        trk.box(-1.95f, 0.72f, 0, 1.05f, 0.85f, 5.1f);            // 左履带
        trk.box(1.95f, 0.72f, 0, 1.05f, 0.85f, 5.1f);             // 右履带
        for (int i = 0; i < 5; i++) {
            float wz = -1.85f + i * 0.92f;
            trk.cylinder(-1.95f, 0.42f - 0.42f + 0.0f, wz, 0.42f, 0.42f, 0.34f, 10);
            trk.cylinder(1.95f, 0.0f, wz, 0.42f, 0.42f, 0.34f, 10);
        }
        trackMesh = trk.build();

        if (foe) {   // 敌方车体偏暗红
            bodyMesh = recolor(bodyMesh, new float[]{0.55f, 0.22f, 0.18f});
        }
    }

    private static Gfx.Mesh recolor(Gfx.Mesh m, float[] c) { return m; }   // 颜色在 Renderer 里按 foe 传入
}
