package com.skyduel.game;

/**
 * 战斗机：模型网格 + 弱点定义 + 飞行物理。
 * 对应网页版 js/plane.js（buildPlane / makeFighter / applyFlight / forwardOf）。
 *
 * 同步提示：TURN_RATE / PITCH_RATE / 速度上下限 / 弱点位置与倍率 必须与 plane.js 一致。
 */
public class Plane {

    // ---- 飞行参数（与 js/main.js 完全同值）----
    public static final float SPEED_MIN = 45f;
    public static final float SPEED_MAX = 170f;
    public static final float TURN_RATE = 2.4f;      // 偏航最大角速度 rad/s
    public static final float PITCH_RATE = 1.8f;     // 俯仰最大角速度 rad/s
    public static final float MAX_AIM = 0.55f;       // 视角最大偏移
    public static final float MAX_PITCH = 1.15f;     // 机体俯仰上限
    public static final float BASE_DMG = 7f;         // 单发机炮伤害
    public static final float HP_MAX = 100f;
    public static final float BULLET_SPEED = 560f;
    public static final float BULLET_LIFE = 3.4f;

    /** 弱点：局部坐标（机头朝 -Z）+ 判定半径 + 伤害倍率 */
    public static final class Weak {
        public final String name;
        public final float[] offset;
        public final float r, mult;
        public Weak(String name, float[] offset, float r, float mult) {
            this.name = name; this.offset = offset; this.r = r; this.mult = mult;
        }
    }

    public static final Weak[] WEAK = {
            new Weak("驾驶舱", new float[]{0f, 0.55f, 0.9f}, 1.05f, 3.0f),
            new Weak("发动机", new float[]{0f, 0f, -3.6f}, 1.15f, 2.5f),
            new Weak("左翼", new float[]{-3.6f, 0f, 0.2f}, 1.35f, 2.0f),
            new Weak("右翼", new float[]{3.6f, 0f, 0.2f}, 1.35f, 2.0f),
            new Weak("机身", new float[]{0f, 0f, 1.2f}, 2.0f, 1.0f),
    };

    // ---- 模型 ----
    public Gfx.Mesh body;      // 机身 + 机翼 + 尾翼
    public Gfx.Mesh glass;     // 座舱盖（半透明）
    public Gfx.Mesh prop;      // 螺旋桨 / 尾焰盘

    // ---- 状态 ----
    public float[] pos = new float[]{0, 280, 900};
    public float yaw = 0, pitch = 0, roll = 0, yawVel = 0;
    public float speed = 95, targetSpeed = 95;
    public float hp = HP_MAX;
    public boolean alive = true;
    public boolean foe;                     // true = 敌机（红色涂装）
    public float[] bodyColor, glassColor, propColor;

    public float propSpin = 0;

    public Plane(boolean foe) {
        this.foe = foe;
        bodyColor = foe ? new float[]{0.78f, 0.20f, 0.16f} : new float[]{0.14f, 0.36f, 0.90f};
        glassColor = new float[]{0.75f, 0.89f, 1.0f};
        propColor = new float[]{0.12f, 0.13f, 0.15f};
        buildMeshes();
    }

    private void buildMeshes() {
        Gfx.Builder b = new Gfx.Builder();
        // 机身：细长六棱柱，机头 -Z
        b.cylinder(0, -0.55f, 3.4f, 0.62f, 0.30f, 1.1f, 8);      // 尾段
        b.cylinder(0, -0.55f, -2.2f, 0.34f, 0.62f, 5.6f, 8);     // 中段（z 从 -2.2 到 3.4）
        b.cylinder(0, -0.42f, -5.3f, 0.16f, 0.34f, 3.1f, 8);     // 机头锥（z 从 -5.3 到 -2.2）
        // 主翼（后掠）
        b.wing(-5.2f, -0.7f, -0.35f, 0.6f, 3.4f, 0.34f);
        b.wing(0.7f, 5.2f, -0.35f, 0.6f, 3.4f, 0.34f);
        // 平尾 + 垂尾
        b.wing(-2.4f, -0.4f, 0.15f, 3.0f, 4.4f, 0.22f);
        b.wing(0.4f, 2.4f, 0.15f, 3.0f, 4.4f, 0.22f);
        b.box(0, 1.15f, 4.0f, 0.18f, 2.1f, 1.7f);                // 垂尾
        body = b.build();

        Gfx.Builder g = new Gfx.Builder();
        g.box(0, 0.62f, 0.55f, 0.95f, 0.62f, 2.0f);              // 座舱盖（对应弱点"驾驶舱"位置）
        glass = g.build();

        Gfx.Builder p = new Gfx.Builder();
        p.box(0, 0, -5.75f, 1.9f, 0.16f, 0.16f);                 // 螺旋桨叶片
        prop = p.build();
    }

    public void reset(float[] spawn) {
        pos = new float[]{spawn[0], spawn[1], spawn[2]};
        yaw = spawn[3];
        pitch = 0; roll = 0; yawVel = 0;
        speed = 95; targetSpeed = 95;
        hp = HP_MAX; alive = true;
        propSpin = 0;
    }

    /** 机头方向（对应 plane.js 的 forwardOf：Euler(pitch, yaw, 0, 'YXZ') 作用到 (0,0,-1)） */
    public float[] forward() {
        float cp = (float) Math.cos(pitch), sp = (float) Math.sin(pitch);
        float cy = (float) Math.cos(yaw), sy = (float) Math.sin(yaw);
        // Ry(yaw) * Rx(pitch) * (0,0,-1)
        float x = -(sp * 0) + 0, y0 = sp, z0 = -cp;
        return new float[]{ cy * x + sy * z0, y0, -sy * x + cy * z0 };
    }

    /** 机体上方向（滚转后的 up，用于相机） */
    public float[] up() {
        float[] f = forward();
        float[] worldUp = {0, 1, 0};
        float[] right = M4.norm(M4.cross(worldUp, f));
        float cr = (float) Math.cos(-roll), sr = (float) Math.sin(-roll);
        // 在 (right, up) 平面内绕前轴旋转
        float[] baseUp = M4.cross(f, right);
        float[] u = M4.add(M4.mul(baseUp, cr), M4.mul(right, sr));
        return M4.norm(u);
    }

    /** 物理积分（逐行对应 plane.js 的 applyFlight） */
    public void apply(float dt) {
        speed += (targetSpeed - speed) * Math.min(1f, dt * 1.3f);
        float[] f = forward();
        pos[0] += f[0] * speed * dt;
        pos[1] += f[1] * speed * dt;
        pos[2] += f[2] * speed * dt;
        // 视觉滚转：yawVel * 0.38 夹到 ±1.05，按 dt*5.5 平滑（与网页版同参）
        float target = M4.clamp(yawVel * 0.38f, -1.05f, 1.05f);
        roll += (target - roll) * Math.min(1f, dt * 5.5f);
        propSpin -= dt * (12f + speed * 0.4f);
    }

    /** 模型矩阵（平移 * 旋转） */
    public float[] model() {
        float[] t = M4.translate(pos[0], pos[1], pos[2]);
        float[] r = M4.rotYXZ(pitch, yaw, roll);
        float[] out = new float[16];
        M4.mul(out, t, r);
        return out;
    }

    /** 第 i 个弱点在世界坐标下的位置 */
    public float[] weakWorld(int i) {
        float[] o = WEAK[i].offset;
        float[] r = M4.rotYXZ(pitch, yaw, roll);
        return new float[]{
                r[0] * o[0] + r[4] * o[1] + r[8]  * o[2] + pos[0],
                r[1] * o[0] + r[5] * o[1] + r[9]  * o[2] + pos[1],
                r[2] * o[0] + r[6] * o[1] + r[10] * o[2] + pos[2]
        };
    }

    /** 线段（子弹上一帧→当前帧）是否命中某个弱点，返回下标；未命中返回 -1 */
    public int hitTest(float[] a, float[] b) {
        for (int i = 0; i < WEAK.length; i++) {
            float[] c = weakWorld(i);
            float rr = WEAK[i].r + 0.35f;
            if (segSphere(a, b, c, rr)) return i;
        }
        return -1;
    }

    private static boolean segSphere(float[] a, float[] b, float[] c, float r) {
        float[] ab = M4.sub(b, a);
        float abLen2 = M4.dot(ab, ab);
        float t = abLen2 < 1e-6f ? 0f : M4.clamp(M4.dot(M4.sub(c, a), ab) / abLen2, 0f, 1f);
        float[] p = M4.add(a, M4.mul(ab, t));
        return M4.dist(p, c) <= r;
    }
}
