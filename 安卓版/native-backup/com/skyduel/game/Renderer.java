package com.skyduel.game;

import android.opengl.GLES20;
import android.opengl.GLSurfaceView;

import javax.microedition.khronos.egl.EGLConfig;
import javax.microedition.khronos.opengles.GL10;

/**
 * 渲染器：所有绘制都在这里（原生 OpenGL ES 2.0，无浏览器、无 WebView）。
 * 绘制顺序：天空穹顶（关深度）→ 海面 / 群岛 → 飞机 → 曳光弹 → 爆炸粒子（加法混合）。
 */
public class Renderer implements GLSurfaceView.Renderer {

    private final HudView hud;
    private final Sfx sfx;

    private Game game;
    private World world;

    private int progBody, progSky;
    private int aPosBody, aNrmBody, uMVPM, uModelB, uCamB, uColorB, uLightB, uFogCB, uFogNB, uFogFB, uAmbB, uAlphaB;
    private int aPosSky, uMVPS, uTopS, uHorS, uSunS, uTintS;

    private Gfx.Mesh bulletMesh, quadMesh;
    private final float[] tmpA = new float[16], tmpB = new float[16], tmpC = new float[16], mvp = new float[16];

    public Renderer(HudView hud, Sfx sfx) { this.hud = hud; this.sfx = sfx; }

    @Override
    public void onSurfaceCreated(GL10 gl, EGLConfig config) {
        GLES20.glEnable(GLES20.GL_DEPTH_TEST);
        GLES20.glDisable(GLES20.GL_CULL_FACE);          // low-poly 网格双面可见，避免漏面
        GLES20.glClearColor(0.53f, 0.71f, 0.85f, 1f);

        progBody = Gfx.program(Gfx.VS_BODY, Gfx.FS_BODY);
        progSky = Gfx.program(Gfx.VS_SKY, Gfx.FS_SKY);
        aPosBody = GLES20.glGetAttribLocation(progBody, "aPos");
        aNrmBody = GLES20.glGetAttribLocation(progBody, "aNrm");
        uMVPM = GLES20.glGetUniformLocation(progBody, "uMVP");
        uModelB = GLES20.glGetUniformLocation(progBody, "uModel");
        uCamB = GLES20.glGetUniformLocation(progBody, "uCam");
        uColorB = GLES20.glGetUniformLocation(progBody, "uColor");
        uLightB = GLES20.glGetUniformLocation(progBody, "uLight");
        uFogCB = GLES20.glGetUniformLocation(progBody, "uFogColor");
        uFogNB = GLES20.glGetUniformLocation(progBody, "uFogNear");
        uFogFB = GLES20.glGetUniformLocation(progBody, "uFogFar");
        uAmbB = GLES20.glGetUniformLocation(progBody, "uAmbient");
        uAlphaB = GLES20.glGetUniformLocation(progBody, "uAlpha");

        aPosSky = GLES20.glGetAttribLocation(progSky, "aPos");
        uMVPS = GLES20.glGetUniformLocation(progSky, "uMVP");
        uTopS = GLES20.glGetUniformLocation(progSky, "uTop");
        uHorS = GLES20.glGetUniformLocation(progSky, "uHorizon");
        uSunS = GLES20.glGetUniformLocation(progSky, "uSunDir");
        uTintS = GLES20.glGetUniformLocation(progSky, "uSunTint");

        // 网格必须在 GL 就绪后创建
        world = new World(game != null ? game.mapType : "island");
        game = new Game(world, hud.getInput());
        hud.attachGame(game);

        Gfx.Builder bb = new Gfx.Builder();
        bb.box(0, 0, 0, 0.09f, 0.09f, 4.5f);            // 曳光弹（与网页版弹体尺寸一致）
        bulletMesh = bb.build();

        Gfx.Builder qb = new Gfx.Builder();
        qb.tri3(new float[]{-1, -1, 0}, new float[]{1, -1, 0}, new float[]{1, 1, 0});
        qb.tri3(new float[]{-1, -1, 0}, new float[]{1, 1, 0}, new float[]{-1, 1, 0});
        quadMesh = qb.build();

        sfx.start();
    }

    @Override
    public void onSurfaceChanged(GL10 gl, int width, int height) {
        GLES20.glViewport(0, 0, width, height);
        hud.setViewport(width, height);
    }

    @Override
    public void onDrawFrame(GL10 gl) {
        float dt = hud.tickDelta();

        // 联机换图：mapType 变化 → GL 线程重建世界（天空/海面/群岛/雾参数），Game 等待后开局
        if (game != null && world != null && !world.mapType.equals(game.mapType)) {
            World nw = new World(game.mapType);
            world = nw;
            game.setWorld(nw);
        }

        game.update(dt);
        hud.onFrame();

        GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT | GLES20.GL_DEPTH_BUFFER_BIT);

        float aspect = (float) hud.getWidth() / Math.max(1, hud.getHeight());
        float[] proj = M4.perspective(game.camFov, aspect, 0.1f, 12000f);
        float[] view = M4.lookAt(game.camPos, game.camTarget, game.camUp);

        // ---------- 天空（去掉相机平移 → 视为无限远；半径取 6000，far=12000 永不被裁剪）----------
        GLES20.glDepthMask(false);
        GLES20.glDisable(GLES20.GL_DEPTH_TEST);
        M4.mul(tmpA, proj, viewNoTranslation(view));
        M4.mul(mvp, tmpA, M4.scale(6000f, 6000f, 6000f));
        GLES20.glUseProgram(progSky);
        GLES20.glUniformMatrix4fv(uMVPS, 1, false, mvp, 0);
        GLES20.glUniform3f(uTopS, world.skyTop[0], world.skyTop[1], world.skyTop[2]);
        GLES20.glUniform3f(uHorS, world.skyHorizon[0], world.skyHorizon[1], world.skyHorizon[2]);
        float[] sd = M4.norm(new float[]{0.45f, 0.72f, 0.53f});
        GLES20.glUniform3f(uSunS, sd[0], sd[1], sd[2]);
        GLES20.glUniform3f(uTintS, 1f, 0.94f, 0.78f);
        world.sky.draw(aPosSky, -1);
        GLES20.glEnable(GLES20.GL_DEPTH_TEST);
        GLES20.glDepthMask(true);

        // ---------- 场景实体 ----------
        GLES20.glUseProgram(progBody);
        GLES20.glUniform3f(uLightB, sd[0], sd[1], sd[2]);
        GLES20.glUniform3f(uFogCB, world.fogColor[0], world.fogColor[1], world.fogColor[2]);
        GLES20.glUniform1f(uFogNB, world.fogNear);
        GLES20.glUniform1f(uFogFB, world.fogFar);
        GLES20.glUniform1f(uAmbB, 0.62f);
        GLES20.glUniform3f(uCamB, game.camPos[0], game.camPos[1], game.camPos[2]);

        // 海面
        M4.mul(tmpA, proj, view);
        drawMesh(world.sea, M4.identity(), new float[]{0.11f, 0.37f, 0.54f}, 1f, false, tmpA);
        // 群岛（沙滩 / 岩石 / 树）
        drawMesh(world.groundA, M4.identity(), new float[]{0.79f, 0.73f, 0.54f}, 1f, false, tmpA);
        drawMesh(world.groundB, M4.identity(), new float[]{0.44f, 0.48f, 0.42f}, 1f, false, tmpA);
        drawMesh(world.groundC, M4.identity(), new float[]{0.25f, 0.48f, 0.29f}, 1f, false, tmpA);

        // 飞机 / 防空车（我方蓝 / 敌方红）
        if (game.meIsAAGun) drawAAGun(game.meAAGun, tmpA, false); else drawPlane(game.me, tmpA, false);
        if (game.foeIsAAGun) drawAAGun(game.foeAAGun, tmpA, true); else drawPlane(game.foe, tmpA, true);

        // 曳光弹（加法混合，不写深度）
        GLES20.glEnable(GLES20.GL_BLEND);
        GLES20.glBlendFunc(GLES20.GL_SRC_ALPHA, GLES20.GL_ONE);
        GLES20.glDepthMask(false);
        for (int i = 0; i < Game.MAX_BULLETS; i++) {
            if (!game.bactive[i]) continue;
            float[] dir = {game.bvx[i], game.bvy[i], game.bvz[i]};
            float[] rot = M4.alignMinusZ(dir);
            M4.mul(tmpB, M4.translate(game.bx[i], game.by[i], game.bz[i]), rot);
            drawMesh(bulletMesh, tmpB, game.bmine[i] ? new float[]{1f, 0.82f, 0.48f} : new float[]{1f, 0.54f, 0.48f}, 1f, true, tmpA);
        }

        // 爆炸粒子（朝向相机的四边形）
        float[] camRight = {view[0], view[4], view[8]};
        float[] camUpV = {view[1], view[5], view[9]};
        for (int i = 0; i < Game.MAX_PARTS; i++) {
            if (!game.pactive[i]) continue;
            float k = game.plife[i] / Math.max(0.01f, game.pmax[i]);
            float s = game.psize[i] * (0.4f + 0.6f * k);
            float[] model = new float[16];
            // 基向量 = 相机右/上，尺寸 = s
            model[0] = camRight[0] * s; model[1] = camRight[1] * s; model[2] = camRight[2] * s;
            model[4] = camUpV[0] * s;   model[5] = camUpV[1] * s;   model[6] = camUpV[2] * s;
            model[8] = 0; model[9] = 0; model[10] = 1;
            model[12] = game.px[i]; model[13] = game.py[i]; model[14] = game.pz[i]; model[15] = 1;
            float[] col = {game.pcr[i], game.pcg[i], game.pcb[i]};
            drawMesh(quadMesh, model, col, k * 0.9f, true, tmpA);
        }
        GLES20.glDepthMask(true);
        GLES20.glDisable(GLES20.GL_BLEND);
    }

    // ================= 工具 =================
    private static float[] viewNoTranslation(float[] view) {
        float[] v = view.clone();
        v[12] = 0; v[13] = 0; v[14] = 0;
        return v;
    }

    private void drawMesh(Gfx.Mesh mesh, float[] model, float[] color, float alpha, boolean additive, float[] pv) {
        M4.mul(tmpC, pv, model);
        GLES20.glUniformMatrix4fv(uMVPM, 1, false, tmpC, 0);
        GLES20.glUniformMatrix4fv(uModelB, 1, false, model, 0);
        GLES20.glUniform3f(uColorB, color[0], color[1], color[2]);
        GLES20.glUniform1f(uAlphaB, alpha);
        if (additive) {
            GLES20.glEnable(GLES20.GL_BLEND);
            GLES20.glBlendFunc(GLES20.GL_SRC_ALPHA, GLES20.GL_ONE);
        } else {
            GLES20.glDisable(GLES20.GL_BLEND);
        }
        mesh.draw(aPosBody, aNrmBody);
    }

    private void drawPlane(Plane p, float[] pv, boolean foe) {
        if (p == null || !p.alive) return;
        float[] model = p.model();
        drawMesh(p.body, model, p.bodyColor, 1f, false, pv);
        drawMesh(p.glass, model, p.glassColor, 0.55f, false, pv);
        drawMesh(p.prop, model, p.propColor, 0.9f, false, pv);
    }

    /** 防空车：车体/履带随车体矩阵，雷达/装甲/枪塔随炮塔矩阵（gunMesh 预留，随枪管俯仰） */
    private void drawAAGun(AAGun ag, float[] pv, boolean foe) {
        if (ag == null || !ag.alive) return;
        float[][] ms = ag.models();
        float[] cBody = foe ? new float[]{0.55f, 0.24f, 0.20f} : new float[]{0.42f, 0.52f, 0.35f};
        float[] cDark = new float[]{0.14f, 0.16f, 0.15f};
        float[] cArm  = foe ? new float[]{0.46f, 0.30f, 0.26f} : new float[]{0.50f, 0.56f, 0.44f};
        float[] cTrk  = new float[]{0.15f, 0.15f, 0.16f};
        drawMesh(ag.bodyMesh, ms[0], cBody, 1f, false, pv);
        drawMesh(ag.trackMesh, ms[0], cTrk, 1f, false, pv);
        drawMesh(ag.darkMesh, ms[1], cDark, 1f, false, pv);
        drawMesh(ag.armorMesh, ms[1], cArm, 1f, false, pv);
        if (ag.gunMesh != null) drawMesh(ag.gunMesh, ms[2], cDark, 1f, false, pv);
    }
}
