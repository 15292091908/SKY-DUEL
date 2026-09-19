package com.skyduel.game;

/**
 * 4x4 矩阵与向量数学（列主序，与 OpenGL 一致）。
 * 对应网页版里 three.js 的 Matrix4 / Vector3 / Euler('YXZ')。
 */
public final class M4 {
    private M4() {}

    public static float[] identity() {
        float[] m = new float[16];
        m[0] = m[5] = m[10] = m[15] = 1f;
        return m;
    }

    /** out = a * b */
    public static void mul(float[] out, float[] a, float[] b) {
        for (int c = 0; c < 4; c++) {
            int i = c * 4;
            float b0 = b[i], b1 = b[i + 1], b2 = b[i + 2], b3 = b[i + 3];
            out[i]     = a[0] * b0 + a[4] * b1 + a[8]  * b2 + a[12] * b3;
            out[i + 1] = a[1] * b0 + a[5] * b1 + a[9]  * b2 + a[13] * b3;
            out[i + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
            out[i + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
        }
    }

    /** 便捷版：分配新矩阵返回 */
    public static float[] mul(float[] a, float[] b) {
        float[] o = new float[16];
        mul(o, a, b);
        return o;
    }

    public static float[] perspective(float fovyDeg, float aspect, float near, float far) {
        float[] m = new float[16];
        float f = (float) (1.0 / Math.tan(Math.toRadians(fovyDeg) / 2.0));
        m[0] = f / aspect;
        m[5] = f;
        m[10] = (far + near) / (near - far);
        m[11] = -1f;
        m[14] = 2f * far * near / (near - far);
        return m;
    }

    public static float[] lookAt(float[] eye, float[] center, float[] up) {
        float[] z = norm(sub(eye, center));
        float[] x = norm(cross(up, z));
        float[] y = cross(z, x);
        float[] m = identity();
        m[0] = x[0]; m[4] = y[0]; m[8]  = z[0];
        m[1] = x[1]; m[5] = y[1]; m[9]  = z[1];
        m[2] = x[2]; m[6] = y[2]; m[10] = z[2];
        m[12] = -dot(x, eye); m[13] = -dot(y, eye); m[14] = -dot(z, eye);
        return m;
    }

    public static float[] translate(float x, float y, float z) {
        float[] m = identity();
        m[12] = x; m[13] = y; m[14] = z;
        return m;
    }

    public static float[] scale(float sx, float sy, float sz) {
        float[] m = identity();
        m[0] = sx; m[5] = sy; m[10] = sz;
        return m;
    }

    /** 等价于 three.js 的 Euler(pitch, yaw, roll, 'YXZ')：R = Ry(yaw) * Rx(pitch) * Rz(roll) */
    public static float[] rotYXZ(float pitch, float yaw, float roll) {
        float cy = (float) Math.cos(yaw), sy = (float) Math.sin(yaw);
        float cx = (float) Math.cos(pitch), sx = (float) Math.sin(pitch);
        float cz = (float) Math.cos(roll), sz = (float) Math.sin(roll);
        float[] ry = { cy, 0, -sy, 0,   0, 1, 0, 0,   sy, 0, cy, 0,   0, 0, 0, 1 };
        float[] rx = { 1, 0, 0, 0,   0, cx, sx, 0,   0, -sx, cx, 0,   0, 0, 0, 1 };
        float[] rz = { cz, sz, 0, 0,   -sz, cz, 0, 0,   0, 0, 1, 0,   0, 0, 0, 1 };
        float[] t = new float[16];
        mul(t, ry, rx);
        float[] out = new float[16];
        mul(out, t, rz);
        return out;
    }

    /** 把模型的 -Z 轴对齐到给定方向（子弹曳光 / 相机朝向用） */
    public static float[] alignMinusZ(float[] dirIn) {
        float[] f = norm(new float[]{dirIn[0], dirIn[1], dirIn[2]});
        float[] up = Math.abs(f[1]) > 0.99f ? new float[]{1, 0, 0} : new float[]{0, 1, 0};
        float[] x = norm(cross(up, f));
        float[] y = cross(f, x);
        float[] m = identity();
        m[0] = x[0]; m[4] = y[0]; m[8]  = -f[0];
        m[1] = x[1]; m[5] = y[1]; m[9]  = -f[1];
        m[2] = x[2]; m[6] = y[2]; m[10] = -f[2];
        return m;
    }

    public static float[] sub(float[] a, float[] b) { return new float[]{a[0]-b[0], a[1]-b[1], a[2]-b[2]}; }
    public static float[] add(float[] a, float[] b) { return new float[]{a[0]+b[0], a[1]+b[1], a[2]+b[2]}; }
    public static float[] mul(float[] a, float s)   { return new float[]{a[0]*s, a[1]*s, a[2]*s}; }
    public static float dot(float[] a, float[] b)   { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]; }
    public static float[] cross(float[] a, float[] b) {
        return new float[]{ a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0] };
    }
    public static float len(float[] a) { return (float) Math.sqrt(dot(a, a)); }
    public static float[] norm(float[] a) {
        float l = len(a);
        if (l < 1e-6f) return new float[]{0, 0, 1};
        return new float[]{a[0]/l, a[1]/l, a[2]/l};
    }
    public static float dist(float[] a, float[] b) { return len(sub(a, b)); }
    public static float clamp(float v, float lo, float hi) { return v < lo ? lo : (v > hi ? hi : v); }
    public static float lerp(float a, float b, float t) { return a + (b - a) * t; }
}
