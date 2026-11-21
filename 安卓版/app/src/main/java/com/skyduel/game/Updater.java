package com.skyduel.game;

import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.net.ConnectivityManager;
import android.net.NetworkInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.Settings;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 版本校验与自更新。
 *
 * 版本号单一来源：安卓版/app/build.gradle 的 versionName（打包脚本 server/pack.js 会把它
 * 写进 发布/version.json，并把 APK 复制成 苍穹对决v<版本>.apk 一并发布）。
 *
 * 取远端版本的顺序：
 *   ① https://game.4365754.xyz/version.json（首选，结构化、稳定）
 *   ② 退化为抓取站点首页 HTML，解析「苍穹对决v<版本>.apk」文件名
 * 两者都拿不到时抛 IOException，由调用方决定"断网拦截"还是"放过"。
 */
final class Updater {

    static final String SITE = "https://game.4365754.xyz/";
    private static final int TIMEOUT_MS = 6000;
    private static final long MIN_APK_BYTES = 100 * 1024;   // 小于 100KB 视为下载失败/被劫持

    static final class Info {
        String version = "";
        String apkName = "";
        String url = "";
        long size = 0;
    }

    private Updater() {}

    static Info fetch() throws IOException {
        try {
            JSONObject o = new JSONObject(get(SITE + "version.json"));
            Info i = new Info();
            i.version = o.optString("version", "").trim();
            i.apkName = o.optString("apk", "").trim();
            i.url = o.optString("url", "").trim();
            i.size = o.optLong("size", 0);
            if (i.version.length() > 0) {
                if (i.url.length() == 0 && i.apkName.length() > 0) i.url = withHost(i.apkName);
                return i;
            }
        } catch (Exception ignore) { /* 退化为解析首页 HTML */ }

        String html = get(SITE);
        Matcher m = Pattern.compile("苍穹对决v?([0-9]+(?:\\.[0-9]+)+)\\.apk").matcher(html);
        if (m.find()) {
            Info i = new Info();
            i.version = m.group(1);
            i.apkName = m.group(0);
            i.url = withHost(i.apkName);
            return i;
        }
        throw new IOException("站点上找不到带版本号的安装包");
    }

    /** 语义化比较：a > b 返回正数，相等返回 0（缺位补 0，非数字忽略） */
    static int compare(String a, String b) {
        String[] x = (a == null ? "" : a).split("\\.");
        String[] y = (b == null ? "" : b).split("\\.");
        int n = Math.max(x.length, y.length);
        for (int k = 0; k < n; k++) {
            int xi = k < x.length ? num(x[k]) : 0;
            int yi = k < y.length ? num(y[k]) : 0;
            if (xi != yi) return xi - yi;
        }
        return 0;
    }

    private static int num(String s) {
        try { return Integer.parseInt(s.replaceAll("[^0-9]", "")); } catch (Exception e) { return 0; }
    }

    static String ownVersion(Context c) {
        try {
            PackageInfo p = c.getPackageManager().getPackageInfo(c.getPackageName(), 0);
            return p.versionName == null ? "0" : p.versionName;
        } catch (Exception e) { return "0"; }
    }

    @SuppressWarnings("deprecation")
    static boolean isOnline(Context c) {
        try {
            ConnectivityManager cm = (ConnectivityManager) c.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return false;
            NetworkInfo ni = cm.getActiveNetworkInfo();
            return ni != null && ni.isConnected();
        } catch (Exception e) { return false; }
    }

    static long enqueueDownload(Context c, String url, String fileName) {
        try {
            DownloadManager.Request r = new DownloadManager.Request(Uri.parse(url));
            r.setTitle("苍穹对决 " + fileName);
            r.setDescription("正在下载新版本…");
            r.setMimeType("application/vnd.android.package-archive");
            r.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            r.setDestinationInExternalFilesDir(c, Environment.DIRECTORY_DOWNLOADS, fileName);
            DownloadManager dm = (DownloadManager) c.getSystemService(Context.DOWNLOAD_SERVICE);
            return dm == null ? -1 : dm.enqueue(r);
        } catch (Exception e) { return -1; }
    }

    static File downloadedFile(Context c, String fileName) {
        File dir = c.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        return new File(dir == null ? c.getCacheDir() : dir, fileName);
    }

    static boolean looksComplete(File apk) { return apk != null && apk.exists() && apk.length() >= MIN_APK_BYTES; }

    /** 调起系统安装器；Android 8+ 需先授予"安装未知应用"权限 */
    static void install(Context c, File apk) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !c.getPackageManager().canRequestPackageInstalls()) {
            try {
                c.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + c.getPackageName())).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                toast(c, "请允许本应用「安装未知应用」，再回到游戏点「立即安装」");
            } catch (Exception e) { toast(c, "请在系统设置中允许安装未知来源应用"); }
            return;
        }
        try {
            Uri uri = FileProvider.getUriForFile(c, c.getPackageName() + ".fileprovider", apk);
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(uri, "application/vnd.android.package-archive");
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            c.startActivity(i);
        } catch (Exception e) { toast(c, "无法启动安装程序，请用浏览器下载安装"); }
    }

    static void openInBrowser(Context c, String url) {
        try {
            c.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (Exception e) { toast(c, "没有可用的浏览器"); }
    }

    private static void toast(Context c, String s) { Toast.makeText(c, s, Toast.LENGTH_LONG).show(); }

    /** 中文文件名要转成 URL 安全形式（Cloudflare Pages 按 UTF-8 文件名提供） */
    private static String withHost(String apkName) {
        try { return new URI("https", null, "game.4365754.xyz", -1, "/" + apkName, null, null).toASCIIString(); }
        catch (Exception e) { return SITE + apkName; }
    }

    private static String get(String url) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        try {
            c.setConnectTimeout(TIMEOUT_MS);
            c.setReadTimeout(TIMEOUT_MS);
            c.setInstanceFollowRedirects(true);
            c.setRequestProperty("User-Agent", "SkyDuelAndroid");
            c.setRequestProperty("Cache-Control", "no-cache");
            int code = c.getResponseCode();
            if (code < 200 || code >= 300) throw new IOException("HTTP " + code);
            InputStream in = c.getInputStream();
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) { bo.write(buf, 0, n); if (bo.size() > (1 << 20)) break; }
            in.close();
            return new String(bo.toByteArray(), StandardCharsets.UTF_8);
        } finally { c.disconnect(); }
    }
}
