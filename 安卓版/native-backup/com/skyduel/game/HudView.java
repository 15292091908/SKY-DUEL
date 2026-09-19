package com.skyduel.game;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.Typeface;
import android.view.MotionEvent;
import android.view.View;

/**
 * HUD + 触屏控件（原生 Canvas 绘制，对应 play/index.html 的 HUD 与触屏按钮）。
 * 同时是玩家输入的持有者：Renderer 里的 Game 直接读取这里的 Input。
 */
public class HudView extends View {

    private final Game.Input input = new Game.Input();
    private volatile Game game;
    private int vw = 1, vh = 1;
    private long lastNano = 0;

    /** 需要 Activity 帮忙做的事（原生对话框输入房间码） */
    public interface UiHost {
        void requestJoinCode(Game g);   // 粘贴房主邀请码
        void showSettings(Game g);      // 设置面板（灵敏度/辅助瞄准/键位）
        void showHelp(Game g);          // 帮助（安卓端专属）
    }

    private UiHost uiHost;
    public void setUiHost(UiHost h) { uiHost = h; }

    private boolean netPanel = false;                 // 联机面板是否展开
    private final android.graphics.RectF btnNet = new android.graphics.RectF();
    private final android.graphics.RectF btnHost = new android.graphics.RectF();
    private final android.graphics.RectF btnJoin = new android.graphics.RectF();
    private final android.graphics.RectF btnClose = new android.graphics.RectF();

    private final Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint pt = new Paint(Paint.ANTI_ALIAS_FLAG);   // 文字
    private final Path path = new Path();

    // 触屏
    private float joyCx, joyCy, joyR = 118f;
    private float fireCx, fireCy, fireR = 66f;
    private float zoomCx, zoomCy, zoomR = 48f;
    private int joyId = -1, dragId = -1, fireId = -1, zoomId = -1;
    private float joyKx, joyKy, lastX, lastY;

    public HudView(Context c) {
        super(c);
        pt.setTypeface(Typeface.create(Typeface.DEFAULT, Typeface.BOLD));
        pt.setColor(Color.WHITE);
        setFocusable(false);
    }

    public Game.Input getInput() { return input; }
    public void attachGame(Game g) { this.game = g; }
    public void setViewport(int w, int h) { vw = Math.max(1, w); vh = Math.max(1, h); }

    /** 帧间隔（供游戏逻辑使用） */
    public float tickDelta() {
        long now = System.nanoTime();
        float dt = lastNano == 0 ? 0.016f : (now - lastNano) / 1_000_000_000f;
        lastNano = now;
        return M4.clamp(dt, 0.001f, 0.05f);
    }

    /** 每帧结束后请求重绘 HUD */
    public void onFrame() { postInvalidateOnAnimation(); }

    // ============================================================ 绘制
    @Override
    protected void onDraw(Canvas cv) {
        Game g = game;
        if (g == null) return;
        float w = getWidth(), h = getHeight();
        float u = Math.min(w, h) / 720f;                      // 统一缩放基准
        if (u < 0.7f) u = 0.7f;

        drawHud(cv, g, w, h, u);
        drawControls(cv, w, h, u);
        drawNetEntry(cv, g, w, h, u);
        if (netPanel) drawNetPanel(cv, g, w, h, u);
        if (g.matchEnded) drawMatchEnd(cv, g, w, h, u);
    }

    private void drawHud(Canvas cv, Game g, float w, float h, float u) {
        // ---- 顶部：回合 + 比分点 ----
        pt.setTextSize(19 * u);
        pt.setTextAlign(Paint.Align.CENTER);
        pt.setColor(Color.WHITE);
        cv.drawText("第 " + g.roundNum + " 回合", w / 2f, 30 * u, pt);
        pt.setTextSize(15 * u);
        pt.setColor(0xFFCCE4FF);
        cv.drawText("五局三胜  " + g.scoreMy() + " : " + g.scoreFoe(), w / 2f, 54 * u, pt);
        float pipR = 5 * u, gap = 17 * u;
        float startX = w / 2f - (Game.WIN_ROUNDS - 1) * gap / 2f;
        for (int i = 0; i < Game.WIN_ROUNDS; i++) {
            p.setStyle(Paint.Style.FILL);
            p.setColor(i < g.scoreMy() ? 0xFF4ADE80 : 0x55204160);
            cv.drawCircle(startX + i * gap, 72 * u, pipR, p);
        }
        for (int i = 0; i < Game.WIN_ROUNDS; i++) {
            p.setColor(i < g.scoreFoe() ? 0xFFFF5A4E : 0x55204160);
            cv.drawCircle(startX + i * gap, 90 * u, pipR, p);
        }

        // ---- 血条：我方（左下）/ 敌方（右下），飞机/防空车按当前实体切换 ----
        float bw = 240 * u, bh = 15 * u;
        float myHp = g.meIsAAGun ? g.meAAGun.hp / AAGun.HP_MAX : g.me.hp / Plane.HP_MAX;
        float foeHp = g.foeIsAAGun ? g.foeAAGun.hp / AAGun.HP_MAX : g.foe.hp / Plane.HP_MAX;
        drawBar(cv, 26 * u, h - 46 * u, bw, bh, myHp, 0xFF3B82F6, g.meIsAAGun ? "我方防空车" : "我方");
        drawBar(cv, w - bw - 26 * u, h - 46 * u, bw, bh, foeHp, 0xFFEF4444, g.foeIsAAGun ? "敌方防空车" : "敌方");

        // ---- 准星：小准星=视角方向（屏幕中心），大准星=机头实际朝向 ----
        float cx = w / 2f, cy = h / 2f;
        p.setStyle(Paint.Style.STROKE);
        p.setStrokeWidth(1.6f * u);
        p.setColor(0xCCFFFFFF);
        cv.drawCircle(cx, cy, 13 * u, p);
        p.setStyle(Paint.Style.FILL);
        cv.drawCircle(cx, cy, 2.4f * u, p);
        // 机头方向与视角的偏移量 → 大准星偏移
        float perRad = (h * 0.5f) / (float) Math.tan(Math.toRadians(g.camFov * 0.5));
        float rx = cx - input.aimYaw * perRad * 0.85f;
        float ry = cy + input.aimPitch * perRad * 0.85f;
        p.setStyle(Paint.Style.STROKE);
        p.setStrokeWidth(2.0f * u);
        p.setColor(0x99BFE4FF);
        cv.drawCircle(rx, ry, 24 * u, p);
        for (int i = 0; i < 4; i++) {
            float a = (float) (Math.PI / 2 * i);
            cv.drawLine(rx + (float) Math.cos(a) * 24 * u, ry + (float) Math.sin(a) * 24 * u,
                    rx + (float) Math.cos(a) * 34 * u, ry + (float) Math.sin(a) * 34 * u, p);
        }

        // ---- 敌机标记（世界坐标投影到屏幕 + 边缘钳制）----
        drawFoeMarker(cv, g, w, h, u);

        // ---- 命中提示 ----
        if (g.hitMsgTime > 0) {
            pt.setTextSize(17 * u);
            pt.setColor(0xFFFFD98A);
            cv.drawText(g.hitMsg, cx, cy - 54 * u, pt);
        }
        // ---- 警告 ----
        if (g.warn != null && !g.warn.isEmpty() && !g.roundOver) {
            pt.setTextSize(20 * u);
            pt.setColor(0xFFFF8A7A);
            cv.drawText(g.warn, w / 2f, h * 0.20f, pt);
        }
        // ---- 回合横幅 ----
        if (g.bannerTime > 0 && !g.banner.isEmpty()) {
            pt.setTextSize(44 * u);
            pt.setColor(Color.argb(235, (int) (g.bannerColor[0] * 255), (int) (g.bannerColor[1] * 255), (int) (g.bannerColor[2] * 255)));
            cv.drawText(g.banner, w / 2f, h * 0.42f, pt);
        }
        // ---- 击杀提示 ----
        if (g.killMsgTime > 0) {
            pt.setTextSize(22 * u);
            pt.setColor(0xFF9BE7A8);
            cv.drawText(g.killMsg, w / 2f, h * 0.52f, pt);
        }
        // ---- 右下角状态 ----
        pt.setTextAlign(Paint.Align.RIGHT);
        pt.setTextSize(12 * u);
        pt.setColor(0x99E8F4FF);
        cv.drawText("FPS " + (int) g.fps + "   敌机 " + (int) g.foeDist() + "m", w - 18 * u, h - 96 * u, pt);
        pt.setTextAlign(Paint.Align.LEFT);

        // 受击红闪
        if (g.hitFlash > 0) {
            p.setStyle(Paint.Style.FILL);
            p.setColor(Color.argb((int) (70 * g.hitFlash), 255, 60, 50));
            cv.drawRect(0, 0, w, h, p);
        }
    }

    private void drawBar(Canvas cv, float x, float y, float bw, float bh, float ratio, int color, String label) {
        p.setStyle(Paint.Style.FILL);
        p.setColor(0x55203A5C);
        cv.drawRoundRect(x, y, x + bw, y + bh, bh / 2, bh / 2, p);
        p.setColor(color);
        float fw = Math.max(0, Math.min(1f, ratio)) * bw;
        if (fw > 1) cv.drawRoundRect(x, y, x + fw, y + bh, bh / 2, bh / 2, p);
        pt.setTextAlign(Paint.Align.LEFT);
        pt.setTextSize(bh * 0.95f);
        pt.setColor(Color.WHITE);
        cv.drawText(label, x, y - bh * 0.35f, pt);
    }

    private void drawFoeMarker(Canvas cv, Game g, float w, float h, float u) {
        boolean foeAlive = g.foeIsAAGun ? g.foeAAGun.alive : g.foe.alive;
        if (!foeAlive) return;
        float[] fp = g.foeIsAAGun ? g.foeAAGun.pos : g.foe.pos;
        float aspect = w / Math.max(1f, h);
        float[] proj = M4.perspective(g.camFov, aspect, 0.1f, 12000f);
        float[] view = M4.lookAt(g.camPos, g.camTarget, g.camUp);
        float[] pv = new float[16];
        M4.mul(pv, proj, view);
        float[] wp = {fp[0], fp[1], fp[2], 1f};
        float[] out = new float[4];
        for (int i = 0; i < 4; i++) {
            out[i] = pv[i] * wp[0] + pv[4 + i] * wp[1] + pv[8 + i] * wp[2] + pv[12 + i] * wp[3];
        }
        float sx = w / 2f, sy = h / 2f;
        boolean front = out[3] > 0.0001f;
        if (front) {
            sx = (out[0] / out[3]) * 0.5f * w + w / 2f;
            sy = h / 2f - (out[1] / out[3]) * 0.5f * h;
        }
        // 屏幕外 → 钳制到边缘（与网页版的边缘钳制一致）
        float m = 46 * u;
        sx = M4.clamp(sx, m, w - m);
        sy = M4.clamp(sy, m, h - m);

        p.setStyle(Paint.Style.FILL);
        p.setColor(0xFFFF4A3D);
        path.reset();
        path.moveTo(sx, sy - 11 * u);
        path.lineTo(sx + 11 * u, sy);
        path.lineTo(sx, sy + 11 * u);
        path.lineTo(sx - 11 * u, sy);
        path.close();
        cv.drawPath(path, p);
        p.setStyle(Paint.Style.STROKE);
        p.setStrokeWidth(1.6f * u);
        p.setColor(0x88FFFFFF);
        cv.drawPath(path, p);
        pt.setTextAlign(Paint.Align.CENTER);
        pt.setTextSize(14 * u);
        pt.setColor(0xFFFFC9C0);
        cv.drawText((int) g.foeDist() + " 米", sx, sy + 27 * u, pt);
        pt.setTextAlign(Paint.Align.LEFT);
    }

    private void drawControls(Canvas cv, float w, float h, float u) {
        // 摇杆
        p.setStyle(Paint.Style.FILL);
        p.setColor(0x44202E44);
        cv.drawCircle(joyCx, joyCy, joyR, p);
        p.setStyle(Paint.Style.STROKE);
        p.setStrokeWidth(2f * u);
        p.setColor(0x88CFE8FF);
        cv.drawCircle(joyCx, joyCy, joyR, p);
        p.setStyle(Paint.Style.FILL);
        p.setColor(0x99E8F4FF);
        cv.drawCircle(joyCx + joyKx, joyCy + joyKy, joyR * 0.34f, p);

        // 开火
        p.setColor(fireId >= 0 ? 0xCCFF8A5C : 0x660E2440);
        cv.drawCircle(fireCx, fireCy, fireR, p);
        p.setStyle(Paint.Style.STROKE);
        p.setColor(0xCCFFFFFF);
        cv.drawCircle(fireCx, fireCy, fireR, p);
        pt.setTextAlign(Paint.Align.CENTER);
        pt.setTextSize(17 * u);
        pt.setColor(Color.WHITE);
        cv.drawText("开火", fireCx, fireCy + 6 * u, pt);

        // 瞄准
        p.setStyle(Paint.Style.FILL);
        p.setColor(zoomId >= 0 ? 0xCC5AA0FF : 0x660E2440);
        cv.drawCircle(zoomCx, zoomCy, zoomR, p);
        p.setStyle(Paint.Style.STROKE);
        p.setColor(0xCCFFFFFF);
        cv.drawCircle(zoomCx, zoomCy, zoomR, p);
        pt.setTextSize(14 * u);
        cv.drawText("瞄准", zoomCx, zoomCy + 5 * u, pt);
        pt.setTextAlign(Paint.Align.LEFT);
    }

    /** 左上角「联机」「设置」「帮助」入口 + 联机中的状态提示 */
    private void drawNetEntry(Canvas cv, Game g, float w, float h, float u) {
        btnNet.set(20 * u, 18 * u, 138 * u, 58 * u);
        btnSet.set(148 * u, 18 * u, 224 * u, 58 * u);
        btnHelp.set(234 * u, 18 * u, 310 * u, 58 * u);
        p.setStyle(Paint.Style.FILL);
        p.setColor(g.netMode == Game.NET_OFF ? 0x66202E44 : 0xCC1E9E6A);
        cv.drawRoundRect(btnNet, 12 * u, 12 * u, p);
        p.setStyle(Paint.Style.STROKE);
        p.setStrokeWidth(1.6f * u);
        p.setColor(0x99CFE8FF);
        cv.drawRoundRect(btnNet, 12 * u, 12 * u, p);
        pt.setTextAlign(Paint.Align.CENTER);
        pt.setTextSize(15 * u);
        pt.setColor(Color.WHITE);
        cv.drawText(g.netMode == Game.NET_OFF ? "联机" : "联机中", btnNet.centerX(), btnNet.centerY() + 5 * u, pt);
        pt.setTextAlign(Paint.Align.LEFT);

        if (g.netMode != Game.NET_OFF && !g.netStatus.isEmpty() && !netPanel) {
            pt.setTextSize(13 * u);
            pt.setColor(0xCCE8F4FF);
            cv.drawText(g.netStatus, 20 * u, 76 * u, pt);
        }

        // 设置 / 帮助 按钮
        p.setStyle(Paint.Style.FILL);
        p.setColor(0x66202E44);
        cv.drawRoundRect(btnSet, 12 * u, 12 * u, p);
        cv.drawRoundRect(btnHelp, 12 * u, 12 * u, p);
        p.setStyle(Paint.Style.STROKE);
        p.setColor(0x99CFE8FF);
        cv.drawRoundRect(btnSet, 12 * u, 12 * u, p);
        cv.drawRoundRect(btnHelp, 12 * u, 12 * u, p);
        pt.setTextAlign(Paint.Align.CENTER);
        pt.setTextSize(15 * u);
        pt.setColor(Color.WHITE);
        cv.drawText("设置", btnSet.centerX(), btnSet.centerY() + 5 * u, pt);
        cv.drawText("帮助", btnHelp.centerX(), btnHelp.centerY() + 5 * u, pt);
        pt.setTextAlign(Paint.Align.LEFT);
    }

    /** 联机面板（原生绘制，按 SDP 流程显示不同按钮） */
    private void drawNetPanel(Canvas cv, Game g, float w, float h, float u) {
        p.setStyle(Paint.Style.FILL);
        p.setColor(0xAA0B1524);
        cv.drawRect(0, 0, w, h, p);
        float pw = Math.min(w * 0.66f, 620 * u), ph = 330 * u;
        float px0 = (w - pw) / 2f, py0 = (h - ph) / 2f;
        p.setColor(0xF0122338);
        cv.drawRoundRect(px0, py0, px0 + pw, py0 + ph, 18 * u, 18 * u, p);
        p.setStyle(Paint.Style.STROKE);
        p.setColor(0x88CFE8FF);
        cv.drawRoundRect(px0, py0, px0 + pw, py0 + ph, 18 * u, 18 * u, p);

        pt.setTextAlign(Paint.Align.CENTER);
        pt.setTextSize(22 * u);
        pt.setColor(Color.WHITE);
        cv.drawText("1v1 联机", px0 + pw / 2f, py0 + 42 * u, pt);
        pt.setTextSize(14 * u);
        pt.setColor(0xFFBFE4FF);
        String status = g.netStatus.isEmpty() ? " " : g.netStatus;
        cv.drawText(status, px0 + pw / 2f, py0 + 74 * u, pt);
        if (!netStatus2.isEmpty()) {
            pt.setTextSize(13 * u);
            pt.setColor(0xFF9FE8C0);
            cv.drawText(netStatus2, px0 + pw / 2f, py0 + 92 * u, pt);
        }

        // 长码展示（截断显示，完整内容靠复制按钮）
        String code = g.netMode == Game.NET_HOST ? g.netOffer : (g.netMode == Game.NET_GUEST ? g.netAnswer : "");
        if (!code.isEmpty()) {
            pt.setTextSize(12 * u);
            pt.setColor(0xFF9FE8C0);
            String show = code.length() > 64 ? code.substring(0, 64) + "…" : code;
            cv.drawText(show, px0 + pw / 2f, py0 + 104 * u, pt);
        }

        // 按钮布局（2 行 × 2 列 + 底部关闭）
        float bw = (pw - 3 * 16 * u) / 2f, bh = 54 * u;
        float x0 = px0 + 16 * u, y1 = py0 + ph - 150 * u, y2 = py0 + ph - 84 * u;
        btnHost.set(x0, y1, x0 + bw, y1 + bh);
        btnJoin.set(x0 + bw + 16 * u, y1, x0 + bw * 2 + 16 * u, y1 + bh);
        btnClose.set(x0 + bw + 16 * u, y2, x0 + bw * 2 + 16 * u, y2 + bh);

        int m = g.netMode;
        if (m == Game.NET_OFF) {
            drawPanelBtn(cv, btnHost, "创建房间", 0xFF1E7FE0, u);
            drawPanelBtn(cv, btnJoin, "加入房间", 0xFF1E9E6A, u);
        } else if (m == Game.NET_HOST && g.netConnected) {
            drawPanelBtn(cv, btnHost, "已联机 ✓", 0xFF1E9E6A, u);
            drawPanelBtn(cv, btnJoin, "（对手视角）", 0xFF2A3A52, u);
        } else if (m == Game.NET_HOST) {
            drawPanelBtn(cv, btnHost, "复制邀请码", 0xFF1E7FE0, u);
            drawPanelBtn(cv, btnJoin, "粘贴应答码", 0xFF1E9E6A, u);
        } else if (g.netConnected) {
            drawPanelBtn(cv, btnHost, "已联机 ✓", 0xFF1E9E6A, u);
            drawPanelBtn(cv, btnJoin, "（房主视角）", 0xFF2A3A52, u);
        } else {
            drawPanelBtn(cv, btnHost, "重新粘贴邀请码", 0xFF1E7FE0, u);
            drawPanelBtn(cv, btnJoin, g.netAnswer.isEmpty() ? "生成应答码中…" : "复制应答码", 0xFF1E9E6A, u);
        }
        // 房主未连接时可切换开局地图（1v1 流程：对手加入后按该地图开局）
        if (m == Game.NET_HOST && !g.netConnected) {
            btnMap.set(x0, y2, x0 + bw, y2 + bh);
            drawPanelBtn(cv, btnMap, "地图: " + mapName(g.hostMap), 0xFF7A5CD6, u);
            actMap = ACT_MAP;
        } else {
            actMap = ACT_NONE;
        }
        drawPanelBtn(cv, btnClose, "关闭", 0xFF5A6A82, u);
        pt.setTextAlign(Paint.Align.LEFT);
        actHost = m == Game.NET_OFF ? ACT_CREATE : (m == Game.NET_HOST && !g.netConnected ? ACT_COPY_OFFER : ACT_NONE);
        actJoin = m == Game.NET_OFF ? ACT_JOIN : (m == Game.NET_HOST && !g.netConnected ? ACT_PASTE_ANSWER : (m == Game.NET_GUEST && !g.netConnected ? ACT_COPY_ANSWER : ACT_NONE));
        actClose = m == Game.NET_OFF ? ACT_CLOSE_PANEL : ACT_EXIT_NET;
    }

    private static final int ACT_NONE = 0, ACT_CREATE = 1, ACT_JOIN = 2, ACT_COPY_OFFER = 3,
            ACT_PASTE_ANSWER = 4, ACT_COPY_ANSWER = 5, ACT_EXIT_NET = 6, ACT_CLOSE_PANEL = 7,
            ACT_SETTINGS = 8, ACT_HELP = 9, ACT_MAP = 10;
    private int actHost = ACT_NONE, actJoin = ACT_NONE, actClose = ACT_NONE, actMap = ACT_NONE;
    private String netStatus2 = "";     // 面板内二次提示（复制成功等）
    private final android.graphics.RectF btnSet = new android.graphics.RectF();
    private final android.graphics.RectF btnHelp = new android.graphics.RectF();
    private final android.graphics.RectF btnMap = new android.graphics.RectF();

    private static String mapName(String m) {
        if ("city".equals(m)) return "都市";
        if ("base".equals(m)) return "军事基地";
        return "海岛";
    }

    private void doPanelAction(Game g, int act) {
        switch (act) {
            case ACT_CREATE: g.startHost(); break;
            case ACT_JOIN: if (uiHost != null) uiHost.requestJoinCode(g); break;
            case ACT_COPY_OFFER: g.copyText(g.netOffer); netStatus2 = "已复制邀请码，发送给对手"; break;
            case ACT_PASTE_ANSWER: if (uiHost != null) uiHost.requestJoinCode(g); break;
            case ACT_COPY_ANSWER: g.copyText(g.netAnswer); netStatus2 = "已复制应答码，发给房主"; break;
            case ACT_MAP:
                if ("island".equals(g.hostMap)) g.hostMap = "city";
                else if ("city".equals(g.hostMap)) g.hostMap = "base";
                else g.hostMap = "island";
                netStatus2 = "开局地图：" + mapName(g.hostMap);
                break;
            case ACT_EXIT_NET: g.stopNet("已退出联机"); netPanel = false; break;
            case ACT_CLOSE_PANEL: netPanel = false; break;
            default: break;
        }
    }

    private void drawPanelBtn(Canvas cv, android.graphics.RectF r, String text, int color, float u) {
        p.setStyle(Paint.Style.FILL);
        p.setColor(color);
        cv.drawRoundRect(r, 12 * u, 12 * u, p);
        pt.setTextAlign(Paint.Align.CENTER);
        pt.setTextSize(16 * u);
        pt.setColor(Color.WHITE);
        cv.drawText(text, r.centerX(), r.centerY() + 6 * u, pt);
        pt.setTextAlign(Paint.Align.LEFT);
    }

    private void drawMatchEnd(Canvas cv, Game g, float w, float h, float u) {
        p.setStyle(Paint.Style.FILL);
        p.setColor(0x99101828);
        cv.drawRect(0, 0, w, h, p);
        pt.setTextAlign(Paint.Align.CENTER);
        pt.setTextSize(56 * u);
        pt.setColor(g.myWin ? 0xFF7CFC98 : 0xFFFF7A6B);
        cv.drawText(g.myWin ? "最终胜利" : "惜败", w / 2f, h / 2f - 10 * u, pt);
        pt.setTextSize(20 * u);
        pt.setColor(Color.WHITE);
        cv.drawText("总比分 " + g.scoreMy() + " : " + g.scoreFoe() + "（五局三胜）", w / 2f, h / 2f + 34 * u, pt);
        pt.setTextSize(17 * u);
        pt.setColor(0xFFBFE4FF);
        cv.drawText("点击屏幕 再来一局", w / 2f, h / 2f + 74 * u, pt);
        pt.setTextAlign(Paint.Align.LEFT);
    }

    // ============================================================ 触屏
    @Override
    public boolean onTouchEvent(MotionEvent e) {
        Game g = game;
        if (g == null) return true;
        float w = getWidth(), h = getHeight();
        lay();

        int action = e.getActionMasked();
        // 联机面板展开时：只响应面板按钮
        if (netPanel) {
            if (action == MotionEvent.ACTION_DOWN) {
                float x = e.getX(), y = e.getY();
                if (btnHost.contains(x, y)) { doPanelAction(g, actHost); return true; }
                if (btnJoin.contains(x, y)) { doPanelAction(g, actJoin); return true; }
                if (btnClose.contains(x, y)) { doPanelAction(g, actClose); return true; }
                if (actMap != ACT_NONE && btnMap.contains(x, y)) { doPanelAction(g, actMap); return true; }
                if (x < btnNet.left || x > btnNet.right || y < btnNet.top || y > btnNet.bottom) {
                    // 点面板外：不关闭，避免误触
                }
                return true;
            }
            return true;
        }
        if (action == MotionEvent.ACTION_DOWN && btnNet.contains(e.getX(), e.getY())) {
            netPanel = true; netStatus2 = "";
            return true;
        }
        if (action == MotionEvent.ACTION_DOWN && btnSet.contains(e.getX(), e.getY())) {
            if (uiHost != null) uiHost.showSettings(g);
            return true;
        }
        if (action == MotionEvent.ACTION_DOWN && btnHelp.contains(e.getX(), e.getY())) {
            if (uiHost != null) uiHost.showHelp(g);
            return true;
        }
        if (action == MotionEvent.ACTION_DOWN && g.matchEnded) {
            g.restartMatch();
            return true;
        }
        switch (action) {
            case MotionEvent.ACTION_DOWN:
            case MotionEvent.ACTION_POINTER_DOWN: {
                int idx = e.getActionIndex();
                float x = e.getX(idx), y = e.getY(idx);
                int id = e.getPointerId(idx);
                if (dist(x, y, fireCx, fireCy) < fireR * 1.25f) { fireId = id; input.firing = true; }
                else if (dist(x, y, zoomCx, zoomCy) < zoomR * 1.35f) { zoomId = id; input.zoom = true; }
                else if (x < w * 0.42f && y > h * 0.42f) {
                    joyId = id; updateJoy(x, y, true);
                } else { dragId = id; lastX = x; lastY = y; }
                break;
            }
            case MotionEvent.ACTION_MOVE: {
                for (int i = 0; i < e.getPointerCount(); i++) {
                    int id = e.getPointerId(i);
                    float x = e.getX(i), y = e.getY(i);
                    if (id == joyId) updateJoy(x, y, false);
                    else if (id == dragId) {
                        input.dragX += (x - lastX) * Game.TOUCH_SENS;
                        input.dragY += (y - lastY) * Game.TOUCH_SENS;
                        lastX = x; lastY = y;
                    }
                }
                break;
            }
            case MotionEvent.ACTION_UP:
            case MotionEvent.ACTION_POINTER_UP: {
                int idx = e.getActionIndex();
                int id = e.getPointerId(idx);
                if (id == fireId) { fireId = -1; input.firing = false; }
                else if (id == zoomId) { zoomId = -1; input.zoom = false; }
                else if (id == joyId) { joyId = -1; joyKx = joyKy = 0; input.steerX = 0; input.throttleCmd = 0; }
                else if (id == dragId) dragId = -1;
                break;
            }
            case MotionEvent.ACTION_CANCEL: {
                joyId = dragId = fireId = zoomId = -1;
                input.firing = false; input.zoom = false; input.steerX = 0; input.throttleCmd = 0;
                joyKx = joyKy = 0;
                break;
            }
            default: break;
        }
        return true;
    }

    private void updateJoy(float x, float y, boolean down) {
        float dx = M4.clamp(x - joyCx, -joyR, joyR);
        float dy = M4.clamp(y - joyCy, -joyR, joyR);
        joyKx = dx; joyKy = dy;
        input.steerX = dx / joyR;                       // 左右 = 连续转向
        input.throttleCmd = down ? 0 : (dy / joyR);     // 上推 = 加速（dy<0 → 负 → 加速）
    }

    private void lay() {
        float w = getWidth(), h = getHeight();
        joyR = Math.min(w, h) * 0.17f;
        joyCx = joyR + w * 0.045f;
        joyCy = h - joyR - h * 0.11f;
        fireR = Math.min(w, h) * 0.105f;
        fireCx = w - fireR - w * 0.045f;
        fireCy = h - fireR - h * 0.10f;
        zoomR = Math.min(w, h) * 0.072f;
        zoomCx = fireCx - fireR - zoomR * 1.35f;
        zoomCy = fireCy - fireR * 0.45f;
    }

    private float dist(float x1, float y1, float x2, float y2) {
        float dx = x1 - x2, dy = y1 - y2;
        return (float) Math.sqrt(dx * dx + dy * dy);
    }
}
