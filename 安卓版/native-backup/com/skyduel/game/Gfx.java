package com.skyduel.game;

import android.opengl.GLES20;
import android.util.Log;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;
import java.util.ArrayList;
import java.util.List;

/**
 * OpenGL ES 着色器与网格工具（对应网页版的 WebGL 部分）。
 * 顶点格式：交错 [x,y,z, nx,ny,nz]，法线按面计算 → 平面着色，与网页版 low-poly 观感一致。
 */
public final class Gfx {
    private Gfx() {}

    // ================= 着色器 =================
    public static int compile(int type, String src) {
        int s = GLES20.glCreateShader(type);
        GLES20.glShaderSource(s, src);
        GLES20.glCompileShader(s);
        int[] ok = new int[1];
        GLES20.glGetShaderiv(s, GLES20.GL_COMPILE_STATUS, ok, 0);
        if (ok[0] == 0) {
            Log.e("SkyDuel", "着色器编译失败: " + GLES20.glGetShaderInfoLog(s));
            GLES20.glDeleteShader(s);
            return 0;
        }
        return s;
    }

    public static int program(String vs, String fs) {
        int v = compile(GLES20.GL_VERTEX_SHADER, vs);
        int f = compile(GLES20.GL_FRAGMENT_SHADER, fs);
        if (v == 0 || f == 0) return 0;
        int p = GLES20.glCreateProgram();
        GLES20.glAttachShader(p, v);
        GLES20.glAttachShader(p, f);
        GLES20.glLinkProgram(p);
        int[] ok = new int[1];
        GLES20.glGetProgramiv(p, GLES20.GL_LINK_STATUS, ok, 0);
        if (ok[0] == 0) {
            Log.e("SkyDuel", "着色器链接失败: " + GLES20.glGetProgramInfoLog(p));
            return 0;
        }
        return p;
    }

    /** 场景统一使用的实体着色器：方向光 + 距离雾（雾参数与 world.js 保持一致） */
    public static final String VS_BODY =
            "attribute vec3 aPos; attribute vec3 aNrm;\n" +
            "uniform mat4 uMVP; uniform mat4 uModel; uniform vec3 uCam;\n" +
            "varying vec3 vN; varying float vDist;\n" +
            "void main(){\n" +
            "  vec4 wp = uModel * vec4(aPos, 1.0);\n" +
            "  vN = mat3(uModel) * aNrm;\n" +
            "  vDist = distance(wp.xyz, uCam);\n" +
            "  gl_Position = uMVP * vec4(aPos, 1.0);\n" +
            "}";

    public static final String FS_BODY =
            "precision mediump float;\n" +
            "varying vec3 vN; varying float vDist;\n" +
            "uniform vec3 uColor; uniform vec3 uLight; uniform vec3 uFogColor;\n" +
            "uniform float uFogNear; uniform float uFogFar; uniform float uAmbient;\n" +
            "uniform float uAlpha;\n" +
            "void main(){\n" +
            "  float d = max(dot(normalize(vN), normalize(uLight)), 0.0);\n" +
            "  vec3 c = uColor * (uAmbient + d * 0.85);\n" +
            "  float f = clamp((vDist - uFogNear) / max(1.0, uFogFar - uFogNear), 0.0, 1.0);\n" +
            "  c = mix(c, uFogColor, f);\n" +
            "  gl_FragColor = vec4(c, uAlpha);\n" +
            "}";

    /** 天空穹顶：与 world.js 的渐变穹顶 + 太阳盘完全同参，且不含噪声（不会出现采样伪影） */
    public static final String VS_SKY =
            "attribute vec3 aPos;\n" +
            "uniform mat4 uMVP;\n" +
            "varying vec3 vDir;\n" +
            "void main(){ vDir = normalize(aPos); gl_Position = uMVP * vec4(aPos, 1.0); }";

    public static final String FS_SKY =
            "precision mediump float;\n" +
            "varying vec3 vDir;\n" +
            "uniform vec3 uTop; uniform vec3 uHorizon; uniform vec3 uSunDir; uniform vec3 uSunTint;\n" +
            "void main(){\n" +
            "  float h = max(vDir.y, 0.0);\n" +
            "  vec3 col = mix(uHorizon, uTop, pow(h, 0.52));\n" +
            "  float s = max(dot(normalize(vDir), normalize(uSunDir)), 0.0);\n" +
            "  col += uSunTint * pow(s, 220.0) * 1.1;\n" +
            "  col += uSunTint * pow(s, 5.0) * 0.16;\n" +
            "  gl_FragColor = vec4(col, 1.0);\n" +
            "}";

    // ================= 网格 =================
    public static final class Mesh {
        public final int vbo;
        public final int count;

        Mesh(int vbo, int count) { this.vbo = vbo; this.count = count; }

        public void bind(int aPos, int aNrm) {
            GLES20.glBindBuffer(GLES20.GL_ARRAY_BUFFER, vbo);
            int stride = 6 * 4;
            GLES20.glEnableVertexAttribArray(aPos);
            GLES20.glVertexAttribPointer(aPos, 3, GLES20.GL_FLOAT, false, stride, 0);
            if (aNrm >= 0) {
                GLES20.glEnableVertexAttribArray(aNrm);
                GLES20.glVertexAttribPointer(aNrm, 3, GLES20.GL_FLOAT, false, stride, 3 * 4);
            }
        }

        public void draw(int aPos, int aNrm) {
            bind(aPos, aNrm);
            GLES20.glDrawArrays(GLES20.GL_TRIANGLES, 0, count);
        }
    }

    public static Mesh upload(float[] interleaved) {
        FloatBuffer buf = ByteBuffer.allocateDirect(interleaved.length * 4)
                .order(ByteOrder.nativeOrder()).asFloatBuffer();
        buf.put(interleaved).position(0);
        int[] id = new int[1];
        GLES20.glGenBuffers(1, id, 0);
        GLES20.glBindBuffer(GLES20.GL_ARRAY_BUFFER, id[0]);
        GLES20.glBufferData(GLES20.GL_ARRAY_BUFFER, interleaved.length * 4, buf, GLES20.GL_STATIC_DRAW);
        return new Mesh(id[0], interleaved.length / 6);
    }

    /** 网格构建器：三角面拼装，法线按面计算 */
    public static final class Builder {
        private final List<float[]> v = new ArrayList<>();

        private void tri(float[] a, float[] b, float[] c) {
            float[] n = M4.norm(M4.cross(M4.sub(b, a), M4.sub(c, a)));
            v.add(new float[]{a[0], a[1], a[2], n[0], n[1], n[2]});
            v.add(new float[]{b[0], b[1], b[2], n[0], n[1], n[2]});
            v.add(new float[]{c[0], c[1], c[2], n[0], n[1], n[2]});
        }

        public Builder tri3(float[] a, float[] b, float[] c) { tri(a, b, c); return this; }

        public Builder quad(float[] a, float[] b, float[] c, float[] d) {
            tri(a, b, c); tri(a, c, d); return this;
        }

        /** 轴对齐长方体（中心 cx,cy,cz，尺寸 sx,sy,sz） */
        public Builder box(float cx, float cy, float cz, float sx, float sy, float sz) {
            float x0 = cx - sx / 2, x1 = cx + sx / 2;
            float y0 = cy - sy / 2, y1 = cy + sy / 2;
            float z0 = cz - sz / 2, z1 = cz + sz / 2;
            float[] a = {x0, y0, z0}, b = {x1, y0, z0}, c = {x1, y1, z0}, d = {x0, y1, z0};
            float[] e = {x0, y0, z1}, f = {x1, y0, z1}, g = {x1, y1, z1}, h = {x0, y1, z1};
            quad(e, f, g, h);   // +Z
            quad(b, a, d, c);   // -Z
            quad(f, b, c, g);   // +X
            quad(a, e, h, d);   // -X
            quad(d, h, g, c);   // +Y
            quad(a, b, f, e);   // -Y
            return this;
        }

        /** 圆锥（底在 y=cy，尖端朝 +Y） */
        public Builder cone(float cx, float cy, float cz, float r, float h, int segs) {
            float[] apex = {cx, cy + h, cz};
            for (int i = 0; i < segs; i++) {
                double a0 = Math.PI * 2 * i / segs, a1 = Math.PI * 2 * (i + 1) / segs;
                float[] p0 = {cx + r * (float) Math.cos(a0), cy, cz + r * (float) Math.sin(a0)};
                float[] p1 = {cx + r * (float) Math.cos(a1), cy, cz + r * (float) Math.sin(a1)};
                tri(p0, p1, apex);
                tri(p1, p0, new float[]{cx, cy, cz});
            }
            return this;
        }

        /** 棱柱 / 圆柱（segs 边数） */
        public Builder cylinder(float cx, float cy, float cz, float rTop, float rBot, float h, int segs) {
            for (int i = 0; i < segs; i++) {
                double a0 = Math.PI * 2 * i / segs, a1 = Math.PI * 2 * (i + 1) / segs;
                float c0 = (float) Math.cos(a0), s0 = (float) Math.sin(a0);
                float c1 = (float) Math.cos(a1), s1 = (float) Math.sin(a1);
                float[] b0 = {cx + rBot * c0, cy, cz + rBot * s0};
                float[] b1 = {cx + rBot * c1, cy, cz + rBot * s1};
                float[] t0 = {cx + rTop * c0, cy + h, cz + rTop * s0};
                float[] t1 = {cx + rTop * c1, cy + h, cz + rTop * s1};
                quad(b0, b1, t1, t0);
                tri(t1, b1, new float[]{cx, cy + h, cz});
                tri(b0, b1, new float[]{cx, cy, cz});
            }
            return this;
        }

        /** 梯形翼面：沿 X 展开，带厚度（机翼/尾翼） */
        public Builder wing(float x0, float x1, float y, float zLead, float zTrail, float thick) {
            float t = thick / 2;
            float[] a = {x0, y + t, zLead}, b = {x1, y + t, zLead};
            float[] c = {x1, y - t, zTrail}, d = {x0, y - t, zTrail};
            float[] a2 = {x0, y - t, zLead}, b2 = {x1, y - t, zLead};
            float[] c2 = {x1, y + t, zTrail}, d2 = {x0, y + t, zTrail};
            quad(a, b, c, d);       // 上表面
            quad(a2, b2, c2, d2);   // 下表面（反向）
            quad(b, a, a2, b2);     // 前缘
            quad(c2, d2, d, c);     // 后缘
            quad(b, b2, c2, c);     // 外侧端面
            quad(d, d2, a2, a);     // 内侧端面
            return this;
        }

        public Mesh build() {
            float[] arr = new float[v.size() * 6];
            int k = 0;
            for (float[] f : v) { System.arraycopy(f, 0, arr, k, 6); k += 6; }
            return upload(arr);
        }
    }
}
