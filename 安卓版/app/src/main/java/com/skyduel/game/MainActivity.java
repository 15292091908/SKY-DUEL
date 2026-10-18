package com.skyduel.game;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewClientCompat;

import java.io.File;

/**
 * 苍穹对决 安卓版（WebView 架构，v0.3.0 起）
 *
 * 打包网页版游戏本体到 assets/web/（与 https://game.4365754.xyz/play/ 同一套代码），
 * 用 WebView 加载运行 —— 手感、画面、联机协议与网页版 1:1 一致，可直接跨端联机。
 *
 * 关键点：
 * - WebViewAssetLoader 以 https://appassets.androidplatform.net 域名提供 assets/web/，
 *   页面获得安全上下文（WebRTC DataChannel / 剪贴板 / getUserMedia 均需要）
 * - DOM storage 开启（设置面板 localStorage）、媒体免手势（WebAudio 合成音效）
 * - onPermissionRequest 授权麦克风（联机语音）
 * - 沉浸式全屏，横屏锁定在 Manifest（sensorLandscape）
 * - 返回键：双击退出（游戏是单页应用，无需页面返回栈）
 * - v0.3.15 起：冷启动先做**版本校验**（Updater）——低于远端版本必须更新才能进游戏，
 *   断网直接拦住；校验通过才把 WebView 挂上并加载游戏。
 */
public class MainActivity extends Activity {

    private static final String GAME_URL = "https://appassets.androidplatform.net/assets/web/index.html";

    private WebView webView;
    private long lastBackAt = 0;

    // ---- 启动版本校验（通过后才加载游戏；断网直接拦住） ----
    private LinearLayout gate;
    private TextView gateText;
    private Button gateRetry, gateUpdate, gateBrowser;
    private boolean gameStarted = false;
    private long dlId = -1;
    private String remoteVer = "", remoteUrl = "", remoteName = "";
    private BroadcastReceiver dlReceiver;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        // https://appassets.androidplatform.net/assets/... → APK assets/（安全上下文，WebRTC 可用）
        final WebViewAssetLoader assetLoader = new WebViewAssetLoader.Builder()
                .setDomain("appassets.androidplatform.net")
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        webView = new WebView(this);            // 先建好但不加载：版本校验通过后才 loadUrl
        setContentView(webView);

        WebSettings ws = webView.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);                     // 设置面板 localStorage 持久化
        ws.setMediaPlaybackRequiresUserGesture(false);     // Web Audio 合成音效自动播
        ws.setAllowFileAccess(false);
        ws.setAllowContentAccess(false);
        ws.setCacheMode(WebSettings.LOAD_NO_CACHE);        // APK 内资源不走缓存，升级即生效
        ws.setTextZoom(100);                               // 忽略系统字体缩放，保证 HUD 布局
        ws.setUseWideViewPort(true);
        ws.setLoadWithOverviewMode(true);

        webView.setWebViewClient(new WebViewClientCompat() {
            @Override
            public WebResourceResponse shouldInterceptRequest(@NonNull WebView view,
                                                              @NonNull WebResourceRequest request) {
                return assetLoader.shouldInterceptRequest(request.getUrl());
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                // 联机语音：页面点「麦克风」按钮时 getUserMedia 触发，这里授予麦克风权限
                runOnUiThread(() -> request.grant(request.getResources()));
            }
        });
        // 战绩导出下载：WebView 里对 Blob 的 <a download> 不可靠，改由原生写入系统「下载」目录
        webView.addJavascriptInterface(new NativeBridge(), "SkyDuelNative");

        registerDownloadReceiver();
        buildGate();
        setContentView(gate);
        immersive();
        if (savedInstanceState == null) startVersionCheck();   // 冷启动：先校验版本
        else startGame();                                      // 进程重建：已校验过，直接进游戏
    }

    /* ================= 启动版本校验（未通过不进游戏） =================
       规则（用户 2026-09-29 定）：
         · 版号取 https://game.4365754.xyz/version.json，缺失则解析站点首页的 apk 文件名
         · 低于远端版本 → 必须更新（下载 + 调起安装器），安装完成后重新打开
         · 断网 → 提示网络问题，不允许进游戏
         · 有网但版本服务异常（404/超时）→ 放过（避免站点小故障把游戏锁死） */

    private void buildGate() {
        gate = new LinearLayout(this);
        gate.setOrientation(LinearLayout.VERTICAL);
        gate.setGravity(Gravity.CENTER);
        gate.setBackgroundColor(0xFF0B1420);
        gate.setPadding(56, 48, 56, 48);

        TextView title = new TextView(this);
        title.setText("苍穹对决");
        title.setTextColor(0xFFE8F2FF);
        title.setTextSize(26);
        title.setGravity(Gravity.CENTER);
        gate.addView(title);

        gateText = new TextView(this);
        gateText.setTextColor(0xFF9FC0E4);
        gateText.setTextSize(15);
        gateText.setGravity(Gravity.CENTER);
        gateText.setPadding(0, 30, 0, 30);
        gate.addView(gateText);

        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER);
        gateRetry = gateBtn("重试");
        gateUpdate = gateBtn("立即更新");
        gateBrowser = gateBtn("用浏览器下载");
        row.addView(gateRetry);
        row.addView(gateUpdate);
        row.addView(gateBrowser);
        gate.addView(row);

        gateRetry.setOnClickListener(v -> startVersionCheck());
        gateUpdate.setOnClickListener(v -> doUpdate());
        gateBrowser.setOnClickListener(v ->
                Updater.openInBrowser(this, remoteUrl.length() > 0 ? remoteUrl : Updater.SITE));
    }

    private Button gateBtn(String label) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.setMargins(14, 0, 14, 0);
        b.setLayoutParams(lp);
        return b;
    }

    private void gateSet(String text, boolean retry, boolean update, boolean browser) {
        gateText.setText(text);
        gateRetry.setVisibility(retry ? View.VISIBLE : View.GONE);
        gateUpdate.setVisibility(update ? View.VISIBLE : View.GONE);
        gateBrowser.setVisibility(browser ? View.VISIBLE : View.GONE);
    }

    private void startVersionCheck() {
        gateSet("正在检查版本…", false, false, false);
        new Thread(() -> {
            Updater.Info info = null;
            try { info = Updater.fetch(); } catch (Exception ignore) { info = null; }
            final Updater.Info fi = info;
            runOnUiThread(() -> onCheckDone(fi));
        }).start();
    }

    private void onCheckDone(Updater.Info info) {
        String mine = Updater.ownVersion(this);
        if (info == null) {
            if (!Updater.isOnline(this)) {
                gateSet("网络连接失败\n\n本游戏启动时需要联网校验版本，请连接网络后重试。", true, false, false);
            } else {
                Toast.makeText(this, "版本校验服务暂不可用，已跳过检查", Toast.LENGTH_LONG).show();
                startGame();
            }
            return;
        }
        if (Updater.compare(info.version, mine) > 0) {
            remoteVer = info.version;
            remoteUrl = info.url;
            remoteName = info.apkName;
            boolean have = remoteName.length() > 0
                    && Updater.looksComplete(Updater.downloadedFile(this, remoteName));
            gateSet("发现新版本 v" + info.version + "（当前 v" + mine + "）\n\n"
                    + "请更新后继续游玩；安装完成后重新打开游戏即可。", false, true, true);
            gateUpdate.setText(have ? "立即安装" : "立即更新");
        } else {
            startGame();   // 已是最新（或本地更新）：放行
        }
    }

    private void doUpdate() {
        File apk = remoteName.length() > 0 ? Updater.downloadedFile(this, remoteName) : null;
        if (Updater.looksComplete(apk)) {                     // 之前下过：直接调安装器
            gateSet("正在打开安装程序…", false, true, true);
            gateUpdate.setText("立即安装");
            Updater.install(this, apk);
            return;
        }
        if (remoteUrl.length() == 0) { Updater.openInBrowser(this, Updater.SITE); return; }
        dlId = Updater.enqueueDownload(this, remoteUrl, remoteName);
        if (dlId < 0) { Updater.openInBrowser(this, remoteUrl); return; }
        gateSet("正在下载 v" + remoteVer + "…\n\n可在通知栏查看进度，下载完成后会自动打开安装程序。",
                false, false, true);
    }

    private void registerDownloadReceiver() {
        dlReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
                if (id != dlId) return;
                File apk = remoteName.length() > 0 ? Updater.downloadedFile(MainActivity.this, remoteName) : null;
                if (Updater.looksComplete(apk)) {
                    gateSet("下载完成，正在打开安装程序…", false, true, true);
                    gateUpdate.setText("立即安装");
                    Updater.install(MainActivity.this, apk);
                } else {
                    gateSet("下载失败，请重试，或改用「用浏览器下载」。", false, true, true);
                }
            }
        };
        IntentFilter f = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(dlReceiver, f, Context.RECEIVER_NOT_EXPORTED);
        else registerReceiver(dlReceiver, f);
    }

    private void startGame() {
        if (gameStarted) return;
        gameStarted = true;
        setContentView(webView);
        webView.loadUrl(GAME_URL);
        immersive();
    }

    /* ================= 战绩导出 下载桥 =================
       网页侧（js/main.js 的 downloadFile）优先调用 window.SkyDuelNative.beginFile/appendChunk/endFile；
       调用失败才退回 Blob 下载。分块写入避免超大字符串一次性过 JSBridge 造成卡顿。
       Android 10+ 写公共「下载」目录（MediaStore，无需权限）；旧版本写应用私有下载目录并提示路径。 */
    private final class NativeBridge {
        private java.io.OutputStream out;
        private String fname = "skyduel.txt";
        private long bytes;

        @JavascriptInterface
        public void beginFile(String fileName) {
            closeQuietly();
            if (fileName != null && fileName.length() > 0) fname = fileName;
            bytes = 0;
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    android.content.ContentValues v = new android.content.ContentValues();
                    v.put(android.provider.MediaStore.MediaColumns.DISPLAY_NAME, fname);
                    v.put(android.provider.MediaStore.MediaColumns.MIME_TYPE, "text/plain");
                    v.put(android.provider.MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                    android.net.Uri uri = getContentResolver()
                            .insert(android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                    out = uri == null ? null : getContentResolver().openOutputStream(uri);
                } else {
                    File dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                    if (dir != null && !dir.exists()) dir.mkdirs();
                    out = new java.io.FileOutputStream(new File(dir, fname));
                }
            } catch (Exception e) { out = null; }
        }

        @JavascriptInterface
        public void appendChunk(String s) {
            if (out == null || s == null) return;
            try {
                byte[] b = s.getBytes(java.nio.charset.StandardCharsets.UTF_8);
                out.write(b);
                bytes += b.length;
            } catch (Exception ignore) { }
        }

        @JavascriptInterface
        public void endFile() {
            boolean ok = out != null;
            try { if (out != null) out.flush(); } catch (Exception ignore) { }
            closeQuietly();
            final String msg = ok
                    ? ("已保存到「下载」：" + fname + "（" + Math.max(1, bytes / 1024) + " KB）")
                    : "保存失败，请检查存储空间";
            runOnUiThread(() -> Toast.makeText(MainActivity.this, msg, Toast.LENGTH_LONG).show());
        }

        private void closeQuietly() { try { if (out != null) out.close(); } catch (Exception ignore) { } out = null; }
    }

    /** 沉浸式全屏（隐藏状态栏 + 导航栏，粘性；刘海屏也全屏铺满） */
    private void immersive() {
        View decor = getWindow().getDecorView();
        decor.setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            WindowManager.LayoutParams lp = getWindow().getAttributes();
            lp.layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            getWindow().setAttributes(lp);
        }
        // 系统栏可见性变化时立即重新沉浸（防止打开面板/输入框后导航栏滞留）
        decor.setOnSystemUiVisibilityChangeListener((vis) -> {
            if ((vis & View.SYSTEM_UI_FLAG_FULLSCREEN) == 0) immersive();
        });
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) immersive();
    }

    @Override
    public void onBackPressed() {
        // 优先让页面关闭已打开的面板（帮助/设置/二级面板）；无面板可关时双击退出
        if (webView != null) {
            webView.evaluateJavascript(
                    "(window.__sdHandleBack && window.__sdHandleBack()) ? '1' : '0'",
                    value -> {
                        if (!"\"1\"".equals(value)) {
                            long now = System.currentTimeMillis();
                            if (now - lastBackAt < 2000) {
                                finish();
                            } else {
                                lastBackAt = now;
                                Toast.makeText(MainActivity.this, "再按一次返回键退出", Toast.LENGTH_SHORT).show();
                            }
                        }
                    });
        } else {
            long now = System.currentTimeMillis();
            if (now - lastBackAt < 2000) finish();
            else {
                lastBackAt = now;
                Toast.makeText(this, "再按一次返回键退出", Toast.LENGTH_SHORT).show();
            }
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (webView != null) webView.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
        immersive();
    }

    @Override
    protected void onDestroy() {
        try { if (dlReceiver != null) unregisterReceiver(dlReceiver); } catch (Exception ignore) { }
        if (webView != null) webView.destroy();
        super.onDestroy();
    }
}
