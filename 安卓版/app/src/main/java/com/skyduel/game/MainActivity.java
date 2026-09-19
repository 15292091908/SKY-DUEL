package com.skyduel.game;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.Toast;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewClientCompat;

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
 */
public class MainActivity extends Activity {

    private WebView webView;
    private long lastBackAt = 0;

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

        webView = new WebView(this);
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

        if (savedInstanceState == null) {
            webView.loadUrl("https://appassets.androidplatform.net/assets/web/index.html");
        }
        immersive();
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
        if (webView != null) webView.destroy();
        super.onDestroy();
    }
}
