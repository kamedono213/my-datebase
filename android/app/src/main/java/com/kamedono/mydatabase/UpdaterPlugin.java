package com.kamedono.mydatabase;

import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * GitHub Releasesの最新版を確認し、新しければダウンロードしてインストール画面を開く。
 * Android OSの仕様上、確認なしの完全サイレント更新はできない
 * (通常のインストール手順とは異なり、パッケージインストーラーの確認タップが1回必要)。
 */
@CapacitorPlugin(name = "Updater")
public class UpdaterPlugin extends Plugin {

    private static final String RELEASES_URL = "https://api.github.com/repos/kamedono213/my-datebase/releases/latest";

    private long downloadId = -1;
    private PluginCall pendingCall;

    @PluginMethod
    public void checkAndInstall(PluginCall call) {
        pendingCall = call;
        new Thread(() -> {
            try {
                URL url = new URL(RELEASES_URL);
                HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                conn.setRequestProperty("Accept", "application/vnd.github+json");
                conn.setConnectTimeout(10000);
                conn.setReadTimeout(10000);

                BufferedReader reader = new BufferedReader(new InputStreamReader(conn.getInputStream()));
                StringBuilder sb = new StringBuilder();
                String line;
                while ((line = reader.readLine()) != null) sb.append(line);
                reader.close();

                JSONObject release = new JSONObject(sb.toString());
                String tagName = release.optString("tag_name", "");
                String latestVersion = tagName.startsWith("v") ? tagName.substring(1) : tagName;

                String currentVersion = getContext()
                    .getPackageManager()
                    .getPackageInfo(getContext().getPackageName(), 0).versionName;

                if (latestVersion.isEmpty() || latestVersion.equals(currentVersion)) {
                    JSObject ret = new JSObject();
                    ret.put("status", "up_to_date");
                    ret.put("currentVersion", currentVersion);
                    call.resolve(ret);
                    return;
                }

                JSONArray assets = release.optJSONArray("assets");
                String downloadUrl = null;
                if (assets != null) {
                    for (int i = 0; i < assets.length(); i++) {
                        JSONObject asset = assets.getJSONObject(i);
                        if (asset.getString("name").endsWith(".apk")) {
                            downloadUrl = asset.getString("browser_download_url");
                            break;
                        }
                    }
                }

                if (downloadUrl == null) {
                    JSObject ret = new JSObject();
                    ret.put("status", "no_apk_asset");
                    call.resolve(ret);
                    return;
                }

                startDownload(downloadUrl, latestVersion);
            } catch (Exception e) {
                call.reject("update_check_failed: " + e.getMessage());
            }
        }).start();
    }

    private void startDownload(String downloadUrl, String latestVersion) {
        Context context = getContext();
        DownloadManager dm = (DownloadManager) context.getSystemService(Context.DOWNLOAD_SERVICE);
        String fileName = "my-datebase-" + latestVersion + ".apk";

        DownloadManager.Request request = new DownloadManager.Request(Uri.parse(downloadUrl));
        request.setDestinationInExternalFilesDir(context, Environment.DIRECTORY_DOWNLOADS, fileName);
        request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
        request.setTitle("知識データベース アップデート");

        BroadcastReceiver receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context ctx, Intent intent) {
                long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
                if (id != downloadId) return;
                context.unregisterReceiver(this);

                File apkFile = new File(context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), fileName);
                if (!apkFile.exists()) {
                    if (pendingCall != null) pendingCall.reject("download_failed");
                    return;
                }

                Uri apkUri = FileProvider.getUriForFile(
                    context,
                    context.getPackageName() + ".fileprovider",
                    apkFile
                );

                Intent installIntent = new Intent(Intent.ACTION_VIEW);
                installIntent.setDataAndType(apkUri, "application/vnd.android.package-archive");
                installIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
                context.startActivity(installIntent);

                if (pendingCall != null) {
                    JSObject ret = new JSObject();
                    ret.put("status", "installing");
                    ret.put("version", latestVersion);
                    pendingCall.resolve(ret);
                }
            }
        };

        IntentFilter filter = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            context.registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED);
        } else {
            context.registerReceiver(receiver, filter);
        }

        downloadId = dm.enqueue(request);
    }
}
