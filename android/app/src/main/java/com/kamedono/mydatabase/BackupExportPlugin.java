package com.kamedono.mydatabase;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * バックアップJSONを端末の「ダウンロード」フォルダへ直接保存するためのブリッジ。
 * WebView上のBlobダウンロードやWeb Share APIは生のCapacitor WebViewには
 * ブリッジされておらず反応しないため、ネイティブのMediaStore経由で確実に
 * 保存する。Android 10以降はMediaStore.Downloadsへ挿入(権限不要)、
 * それより前のバージョンは共有ストレージへの直接書き込みにフォールバックする。
 */
@CapacitorPlugin(name = "BackupExport")
public class BackupExportPlugin extends Plugin {

    @PluginMethod
    public void saveToDownloads(PluginCall call) {
        String filename = call.getString("filename");
        String content = call.getString("content");
        if (filename == null || content == null) {
            call.reject("filenameとcontentは必須です");
            return;
        }

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                saveViaMediaStore(filename, content, call);
            } else {
                saveLegacy(filename, content, call);
            }
        } catch (Exception e) {
            call.reject("保存に失敗しました: " + e.getMessage(), e);
        }
    }

    private void saveViaMediaStore(String filename, String content, PluginCall call) throws Exception {
        ContentResolver resolver = getContext().getContentResolver();
        ContentValues values = new ContentValues();
        values.put(MediaStore.Downloads.DISPLAY_NAME, filename);
        values.put(MediaStore.Downloads.MIME_TYPE, "application/json");
        values.put(MediaStore.Downloads.IS_PENDING, 1);

        Uri item = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        if (item == null) {
            call.reject("保存先を作成できませんでした");
            return;
        }
        try (OutputStream out = resolver.openOutputStream(item)) {
            if (out == null) {
                call.reject("書き込み用のストリームを開けませんでした");
                return;
            }
            out.write(content.getBytes(StandardCharsets.UTF_8));
        }
        values.clear();
        values.put(MediaStore.Downloads.IS_PENDING, 0);
        resolver.update(item, values, null, null);

        JSObject ret = new JSObject();
        ret.put("uri", item.toString());
        call.resolve(ret);
    }

    private void saveLegacy(String filename, String content, PluginCall call) throws Exception {
        // Android 9以前はスコープドストレージが無いため、公開Downloadsフォルダへ
        // 直接書き込める(WRITE_EXTERNAL_STORAGEはAndroidManifestで宣言済み)。
        File downloads = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
        if (!downloads.exists()) downloads.mkdirs();
        File file = new File(downloads, filename);
        try (FileOutputStream out = new FileOutputStream(file)) {
            out.write(content.getBytes(StandardCharsets.UTF_8));
        }
        JSObject ret = new JSObject();
        ret.put("uri", Uri.fromFile(file).toString());
        call.resolve(ret);
    }
}
