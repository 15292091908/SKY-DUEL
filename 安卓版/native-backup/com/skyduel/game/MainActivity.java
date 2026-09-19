package com.skyduel.game;

import android.app.Activity;
import android.app.AlertDialog;
import android.text.InputType;
import android.widget.EditText;
import android.opengl.GLSurfaceView;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.widget.FrameLayout;

/**
 * 唯一入口：启动即进入游戏（没有落地页，没有菜单流程）。
 * 原生 GLSurfaceView 渲染 + 原生 View 绘制 HUD，全程没有 WebView。
 */
public class MainActivity extends Activity implements HudView.UiHost {

    public static android.content.Context appContext;   // 供 Net 剪贴板使用

    private GLSurfaceView glView;
    private Sfx sfx;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        appContext = getApplicationContext();
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                | WindowManager.LayoutParams.FLAG_FULLSCREEN);
        hideSystemBars();

        sfx = new Sfx();
        HudView hud = new HudView(this);
        hud.setUiHost(this);
        Renderer renderer = new Renderer(hud, sfx);

        glView = new GLSurfaceView(this);
        glView.setEGLContextClientVersion(2);
        glView.setPreserveEGLContextOnPause(true);
        glView.setRenderer(renderer);
        glView.setRenderMode(GLSurfaceView.RENDERMODE_CONTINUOUSLY);

        FrameLayout root = new FrameLayout(this);
        root.addView(glView, new FrameLayout.LayoutParams(-1, -1));
        root.addView(hud, new FrameLayout.LayoutParams(-1, -1));
        setContentView(root);
    }

    /** 加入房间：原生对话框粘贴「房主的邀请码」 */
    @Override
    public void requestJoinCode(final Game g) {
        final EditText et = new EditText(this);
        et.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE);
        et.setMinLines(3);
        et.setHint("长按粘贴房主发来的邀请码");
        new AlertDialog.Builder(this)
                .setTitle("粘贴房主的邀请码")
                .setMessage("房主在「创建房间」后会生成邀请码，微信/QQ 发给你后在这里粘贴")
                .setView(et)
                .setPositiveButton("生成应答码", (d, w) -> g.startJoin(et.getText().toString()))
                .setNegativeButton("取消", null)
                .show();
    }

    /** 设置：打开原生对话框（键位/灵敏度/辅助瞄准均在此调整） */
    @Override
    public void showSettings(Game g) {
        final android.widget.LinearLayout box = new android.widget.LinearLayout(this);
        box.setOrientation(android.widget.LinearLayout.VERTICAL);
        int pad = (int) (16 * getResources().getDisplayMetrics().density);
        box.setPadding(pad, pad, pad, pad);
        final android.widget.TextView tv = new android.widget.TextView(this);
        tv.setText("灵敏度 x" + String.format(java.util.Locale.US, "%.2f", Settings.sensMul)
                + "\n辅助瞄准档位：" + (Settings.assist == 0 ? "关" : (Settings.assist == 1 ? "轻微" : "标准"))
                + "\n（点下方按钮调整，改动即时保存）");
        tv.setPadding(0, 0, 0, pad);
        box.addView(tv);
        final android.widget.Button bSens = new android.widget.Button(this);
        bSens.setText("灵敏度 +0.25");
        final android.widget.Button bAssist = new android.widget.Button(this);
        bAssist.setText("切换辅助瞄准");
        final android.widget.Button bSfx = new android.widget.Button(this);
        bSfx.setText("音效：" + (Settings.sfxOn ? "开" : "关"));
        box.addView(bSens); box.addView(bAssist); box.addView(bSfx);
        Runnable refresh = () -> {
            tv.setText("灵敏度 x" + String.format(java.util.Locale.US, "%.2f", Settings.sensMul)
                    + "\n辅助瞄准档位：" + (Settings.assist == 0 ? "关" : (Settings.assist == 1 ? "轻微" : "标准"))
                    + "\n（点下方按钮调整，改动即时保存）");
            bSfx.setText("音效：" + (Settings.sfxOn ? "开" : "关"));
            Settings.save(this);
        };
        bSens.setOnClickListener(v -> {
            Settings.sensMul = Settings.sensMul >= 2.5f ? 0.5f : Settings.sensMul + 0.25f;
            refresh.run();
        });
        bAssist.setOnClickListener(v -> {
            Settings.assist = (Settings.assist + 1) % 3;
            refresh.run();
        });
        bSfx.setOnClickListener(v -> { Settings.sfxOn = !Settings.sfxOn; refresh.run(); });
        new AlertDialog.Builder(this)
                .setTitle("设置")
                .setView(box)
                .setPositiveButton("完成", null)
                .show();
    }

    /** 帮助：安卓端专属说明 */
    @Override
    public void showHelp(Game g) {
        String text = "苍穹对决 · 安卓版 使用说明\n\n"
                + "【操控】左下摇杆：上下=油门（推上加速/拉下减速），左右=转向；\n"
                + "屏幕其余区域拖动=控制视角；右侧「开火」按住连射，「瞄准」按住拉近。\n\n"
                + "【规则】与 AI 或好友进行五局三胜空战：驾驶舱 ×3、发动机 ×2.5、两翼 ×2 伤害。\n"
                + "撞海/撞地/出界都会判负；双方同归于尽判平局、双方均不计分。\n\n"
                + "【联机】与好友在同一 WiFi 下点「联机」：房主「创建房间」生成邀请码，\n"
                + "对手「加入房间」粘贴邀请码后回传应答码即可联机。\n\n"
                + "【关于】本 App 是网页版 https://game.4365754.xyz 的原生移植版，\n"
                + "网页版为原版（含全部地图与完整联机），本移植版会持续跟进同步。\n";
        new AlertDialog.Builder(this)
                .setTitle("帮助")
                .setMessage(text)
                .setPositiveButton("打开网页版", (d, w) -> {
                    try {
                        startActivity(new android.content.Intent(android.content.Intent.ACTION_VIEW,
                                android.net.Uri.parse("https://game.4365754.xyz")));
                    } catch (Throwable ignored) {}
                })
                .setNegativeButton("关闭", null)
                .show();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemBars();
    }

    /** 全屏沉浸（不依赖 AndroidX，直接用平台 API） */
    @SuppressWarnings("deprecation")
    private void hideSystemBars() {
        View d = getWindow().getDecorView();
        d.setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
    }

    @Override
    protected void onResume() {
        super.onResume();
        glView.onResume();
        if (sfx != null) sfx.start();
    }

    @Override
    protected void onPause() {
        super.onPause();
        glView.onPause();
        if (sfx != null) sfx.stop();
    }
}
