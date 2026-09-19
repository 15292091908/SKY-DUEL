package com.skyduel.game;

import java.util.ArrayList;
import java.util.List;
import java.util.Random;

/**
 * 世界：三张地图（海岛/都市/军事基地）。
 * 对应 js/world.js 的 buildIsland / buildCity / buildBase（简化版布局，参数同步）。
 *
 * 同步提示：雾参数/边界/天空配色/地形尺寸 必须与 world.js 保持一致。
 */
public class World {

    // ---- 每图参数（与 world.js 对齐）----
    public String mapType = "island";
    public float fogNear = 1400f, fogFar = 4600f;
    public float[] fogColor = {0.624f, 0.761f, 0.867f};
    public float[] skyTop = {0.118f, 0.388f, 0.784f};
    public float[] skyHorizon = {0.812f, 0.910f, 0.973f};
    public float boundaryWarn = 1700f, boundaryHurt = 2100f, ceiling = 780f;
    public float groundRadius = 4200f;

    /** 碰撞体（球） */
    public static final class Blob {
        public final float x, y, z, r;
        public Blob(float x, float y, float z, float r) { this.x = x; this.y = y; this.z = z; this.r = r; }
    }

    public Gfx.Mesh sky, sea, groundA, groundB, groundB2, groundC, groundD, groundE;
    public final List<Blob> colliders = new ArrayList<>();
    /** 防空车出生点（军事基地 7 处） */
    public final List<float[]> aaSpawns = new ArrayList<>();

    public World(String mapType) {
        this.mapType = mapType;
        if ("city".equals(mapType)) buildCity();
        else if ("base".equals(mapType)) buildBase();
        else buildIsland();
    }

    private void applyFog(float[] fog, float near, float far, float[] top, float[] hor, float gR, float warn, float hurt, float ceil) {
        fogColor = fog; fogNear = near; fogFar = far;
        skyTop = top; skyHorizon = hor;
        boundaryWarn = warn; boundaryHurt = hurt; ceiling = ceil;
        groundRadius = gR;
    }

    // ================= 海岛（原有） =================
    private void buildIsland() {
        applyFog(new float[]{0.624f, 0.761f, 0.867f}, 1400f, 4600f,
                new float[]{0.118f, 0.388f, 0.784f}, new float[]{0.812f, 0.910f, 0.973f},
                4200f, 1700f, 2100f, 780f);
        sky = buildSky();
        sea = disc(4200, 0.0f);
        Gfx.Builder sand = new Gfx.Builder(), rock = new Gfx.Builder(), tree = new Gfx.Builder();
        Random rnd = new Random(20260915L);
        for (int i = 0; i < 16; i++) {
            double ang = rnd.nextDouble() * Math.PI * 2;
            float r = 220 + rnd.nextFloat() * 1230;
            float ix = (float) (Math.cos(ang) * r), iz = (float) (Math.sin(ang) * r);
            if (Math.hypot(ix, iz) < 300) continue;
            float farK = r > 700 ? 1.6f : 1f;
            float baseR = (28 + rnd.nextFloat() * 62) * farK;
            sand.cylinder(ix, 0, iz, baseR * 0.85f, baseR, 10, 18);
            colliders.add(new Blob(ix, 4, iz, baseR * 0.95f));
            int peaks = 1 + rnd.nextInt(3);
            for (int p = 0; p < peaks; p++) {
                float h = 22 + rnd.nextFloat() * 63;
                float cr = 14 + rnd.nextFloat() * Math.max(1, baseR * 0.7f - 14);
                float px = (rnd.nextFloat() - 0.5f) * baseR * 0.8f;
                float pz = (rnd.nextFloat() - 0.5f) * baseR * 0.8f;
                rock.cone(ix + px, 8, iz + pz, cr, h, 14);
                colliders.add(new Blob(ix + px, 8 + h * 0.45f, iz + pz, Math.max(cr * 0.85f, h * 0.42f)));
            }
            for (int t = 0; t < 7; t++) {
                double ta = rnd.nextDouble() * Math.PI * 2;
                float tr = baseR * 0.35f + rnd.nextFloat() * baseR * 0.43f;
                tree.cylinder(ix + (float) Math.cos(ta) * tr, 8, iz + (float) Math.sin(ta) * tr, 0.5f, 0.8f, 4.5f, 6);
                tree.cone(ix + (float) Math.cos(ta) * tr, 12, iz + (float) Math.sin(ta) * tr, 3.2f, 6, 10);
            }
        }
        groundA = sand.build(); groundB = rock.build(); groundC = tree.build();
    }

    // ================= 都市 =================
    private void buildCity() {
        applyFog(new float[]{0.663f, 0.776f, 0.871f}, 1200f, 4400f,
                new float[]{0.231f, 0.463f, 0.839f}, new float[]{0.812f, 0.890f, 0.973f},
                2050f, 1700f, 2100f, 780f);
        sky = buildSky();
        sea = ring(2050f, 4200f, -1.5f, new float[]{0.102f, 0.227f, 0.290f});
        groundA = disc(2050f, 0.0f);   // 街区基底 0x3a3d42

        // 穿城运河（z=600±28）+ 桥
        Gfx.Builder river = new Gfx.Builder();
        river.box(0, 0.12f, 600f, 4100f, 0.24f, 56f);
        groundB = river.build();

        // 道路网格 + 建筑
        Gfx.Builder roads = new Gfx.Builder();     // 道路（浅灰）
        Gfx.Builder bldA = new Gfx.Builder();      // 建筑组 A（深色）
        Gfx.Builder bldB = new Gfx.Builder();      // 建筑组 B（浅色）
        Gfx.Builder green = new Gfx.Builder();     // 公园
        Random rnd = new Random(77);

        for (int i = -6; i <= 6; i++) {
            roads.box(0, 0.4f, i * 240f, 4100f, 0.06f, 20f);      // 大道（沿 X）
            roads.box(i * 240f, 0.4f, 0, 12f, 0.06f, 4100f);      // 街道（沿 Z）
        }

        // 街区建筑（跳过运河带 z∈[572,628] 与公园区）
        for (int bi = -4; bi <= 3; bi++) {
            for (int bj = -4; bj <= 3; bj++) {
                float bx = bi * 240f + 120f, bz = bj * 240f + 120f;
                if (Math.abs(bz - 600f) < 90f) continue;           // 运河带上不放
                if (Math.abs(bx) < 130f && Math.abs(bz) < 130f) {  // 中央公园
                    green.box(bx, 0.3f, bz, 200f, 0.5f, 180f);
                    continue;
                }
                float dist = (float) Math.hypot(bx, bz);
                int count = 1 + rnd.nextInt(3);
                for (int k = 0; k < count; k++) {
                    float hw = 30f + rnd.nextFloat() * 55f;        // 半宽
                    float h;
                    if (dist < 500f) h = 110f + rnd.nextFloat() * 180f;       // 核心：摩天楼
                    else if (dist < 1100f) h = 45f + rnd.nextFloat() * 100f;  // 中环
                    else h = 18f + rnd.nextFloat() * 45f;                      // 郊区
                    float ox = bx + (rnd.nextFloat() - 0.5f) * 60f;
                    float oz = bz + (rnd.nextFloat() - 0.5f) * 60f;
                    (rnd.nextBoolean() ? bldA : bldB).box(ox, h / 2f, oz, hw, h, hw * (0.7f + rnd.nextFloat() * 0.5f));
                    colliders.add(new Blob(ox, h / 2f, oz, Math.max(hw, 14f)));
                }
            }
        }
        groundB2 = roads.build(); groundC = bldA.build();
        groundD = bldB.build(); groundE = green.build();
    }

    // ================= 军事基地 =================
    private void buildBase() {
        applyFog(new float[]{0.624f, 0.753f, 0.847f}, 700f, 2600f,
                new float[]{0.216f, 0.400f, 0.624f}, new float[]{0.812f, 0.878f, 0.973f},
                3200f, 700f, 850f, 780f);
        sky = buildSky();
        sea = ring(420f, 3200f, -1.5f, new float[]{0.102f, 0.290f, 0.416f});
        groundA = disc(420f, 0.0f);           // 草地 0x7a8a5a
        groundB = disc(385f, 0.18f);          // 混凝土场坪 0x8a8a86

        Gfx.Builder con = new Gfx.Builder();  // 混凝土建筑
        Gfx.Builder metal = new Gfx.Builder();
        Gfx.Builder mark = new Gfx.Builder(); // 标线（黄）
        Random rnd = new Random(5);

        // 跑道 46×680
        con.box(0, 0.26f, 0, 46f, 0.06f, 680f);
        // 中央标线
        mark.box(0, 0.30f, 0, 1.0f, 0.02f, 600f);
        // 滑行道边线（黄）
        mark.box(-33f, 0.28f, 0, 1.0f, 0.02f, 620f);
        mark.box(33f, 0.28f, 0, 1.0f, 0.02f, 620f);
        // 滑行道
        con.box(-68f, 0.20f, 0, 40f, 0.05f, 620f);
        con.box(68f, 0.20f, 0, 40f, 0.05f, 620f);

        // 机库 ×2（横放圆柱 r11 h24）
        for (float[] hxz : new float[][]{{-135, -170}, {135, -170}}) {
            con.cylinder(hxz[0], 0, hxz[1], 11f, 11f, 24f, 12);
            colliders.add(new Blob(hxz[0], 11, hxz[1], 14f));
        }
        // 塔台（10×20×10 + 顶 13×5×13）
        con.box(85f, 10f, -390f, 10f, 20f, 10f);
        metal.box(85f, 22.5f, -390f, 13f, 5f, 13f);
        colliders.add(new Blob(85f, 11, -390f, 9f));
        // 雷达站
        con.cylinder(-170f, 0, 340f, 2f, 3.2f, 30f, 8);
        metal.cylinder(-170f, 30f, 340f, 7f, 7f, 1.2f, 12);
        colliders.add(new Blob(-170f, 8, 340f, 5f));
        // 油罐 ×3
        for (float[] txz : new float[][]{{155, 215}, {155, 265}, {155, 315}}) {
            metal.cylinder(txz[0], 0, txz[1], 9f, 9f, 17f, 12);
            colliders.add(new Blob(txz[0], 8, txz[1], 10f));
        }
        // 碉堡 ×2
        for (float[] bxz : new float[][]{{-280, 280}, {280, -280}}) {
            con.box(bxz[0], 3f, bxz[1], 20f, 6f, 16f);
            colliders.add(new Blob(bxz[0], 3, bxz[1], 13f));
        }
        // 直升机坪 + 直升机
        con.cylinder(-150f, 0.1f, 80f, 13f, 13f, 0.2f, 20);
        metal.cylinder(-150f, 1.3f, 80f, 4.5f, 4.5f, 2.2f, 8);

        // 围栏（半径 393 视觉圈）
        for (int i = 0; i < 48; i++) {
            double a = Math.PI * 2 * i / 48;
            float fx = (float) (393 * Math.cos(a)), fz = (float) (393 * Math.sin(a));
            mark.box(fx, 1.2f, fz, 2f, 2.4f, 2f);
        }

        groundC = con.build();
        groundD = metal.build();
        groundE = mark.build();

        // 防空车出生点 ×7
        for (float[] s : new float[][]{{-90, -60}, {90, -60}, {-90, 210}, {90, 210}, {-90, -280}, {90, -280}, {0, 385}})
            aaSpawns.add(new float[]{s[0], 0, s[1]});
    }

    // ================= 几何工具 =================
    private Gfx.Mesh disc(float radius, float y) {
        Gfx.Builder b = new Gfx.Builder();
        int seg = 72;
        for (int i = 0; i < seg; i++) {
            double a0 = Math.PI * 2 * i / seg, a1 = Math.PI * 2 * (i + 1) / seg;
            b.tri3(new float[]{0, y, 0},
                    new float[]{radius * (float) Math.cos(a0), y, radius * (float) Math.sin(a0)},
                    new float[]{radius * (float) Math.cos(a1), y, radius * (float) Math.sin(a1)});
        }
        return b.build();
    }

    private Gfx.Mesh ring(float r0, float r1, float y, float[] color) {
        Gfx.Builder b = new Gfx.Builder();
        int seg = 64;
        for (int i = 0; i < seg; i++) {
            double a0 = Math.PI * 2 * i / seg, a1 = Math.PI * 2 * (i + 1) / seg;
            float c0 = (float) Math.cos(a0), s0 = (float) Math.sin(a0);
            float c1 = (float) Math.cos(a1), s1 = (float) Math.sin(a1);
            b.quad(new float[]{r0 * c0, y, r0 * s0}, new float[]{r1 * c0, y, r1 * s0},
                    new float[]{r1 * c1, y, r1 * s1}, new float[]{r0 * c1, y, r0 * s1});
        }
        return b.build();
    }

    private Gfx.Mesh buildSky() {
        Gfx.Builder b = new Gfx.Builder();
        int rings = 15, segs = 32;
        for (int j = 0; j < rings; j++) {
            double p0 = Math.PI * j / rings, p1 = Math.PI * (j + 1) / rings;
            for (int i = 0; i < segs; i++) {
                double t0 = Math.PI * 2 * i / segs, t1 = Math.PI * 2 * (i + 1) / segs;
                float[] v00 = sph(p0, t0), v01 = sph(p0, t1), v10 = sph(p1, t0), v11 = sph(p1, t1);
                b.tri3(v00, v10, v11);
                b.tri3(v00, v11, v01);
            }
        }
        return b.build();
    }

    private static float[] sph(double phi, double theta) {
        float y = (float) Math.cos(phi);
        float s = (float) Math.sin(phi);
        return new float[]{s * (float) Math.cos(theta), y, s * (float) Math.sin(theta)};
    }

    /** 是否撞上地形 */
    public boolean hitTerrain(float[] p, float radius) {
        for (Blob c : colliders) {
            float dx = p[0] - c.x, dy = p[1] - c.y, dz = p[2] - c.z;
            float rr = c.r + radius;
            if (dx * dx + dy * dy + dz * dz < rr * rr) return true;
        }
        return false;
    }

}
