package com.kamedono.mydatabase;

import android.Manifest;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * Web側（app.js等）から常駐アイコンのON/OFF・権限確認を行うためのブリッジ。
 * マイク権限（オーバーレイ内の音声入力ボタン用）もここで扱う。
 */
@CapacitorPlugin(
    name = "OverlayBubble",
    permissions = {
        @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO })
    }
)
public class OverlayPlugin extends Plugin {

    @PluginMethod
    public void checkPermission(PluginCall call) {
        JSObject result = new JSObject();
        result.put("granted", hasOverlayPermission());
        call.resolve(result);
    }

    @PluginMethod
    public void requestPermission(PluginCall call) {
        if (hasOverlayPermission()) {
            JSObject result = new JSObject();
            result.put("granted", true);
            call.resolve(result);
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            Intent intent = new Intent(
                Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                Uri.parse("package:" + getContext().getPackageName())
            );
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
        }
        // 設定画面から戻ってきた後の結果はJS側でcheckPermissionを呼び直して確認する想定
        JSObject result = new JSObject();
        result.put("granted", hasOverlayPermission());
        call.resolve(result);
    }

    @PluginMethod
    public void checkMicPermission(PluginCall call) {
        JSObject result = new JSObject();
        result.put("granted", getPermissionState("microphone") == com.getcapacitor.PermissionState.GRANTED);
        call.resolve(result);
    }

    @PluginMethod
    public void requestMicPermission(PluginCall call) {
        if (getPermissionState("microphone") == com.getcapacitor.PermissionState.GRANTED) {
            JSObject result = new JSObject();
            result.put("granted", true);
            call.resolve(result);
            return;
        }
        requestPermissionForAlias("microphone", call, "micPermissionCallback");
    }

    @PermissionCallback
    private void micPermissionCallback(PluginCall call) {
        JSObject result = new JSObject();
        result.put("granted", getPermissionState("microphone") == com.getcapacitor.PermissionState.GRANTED);
        call.resolve(result);
    }

    @PluginMethod
    public void startBubble(PluginCall call) {
        if (!hasOverlayPermission()) {
            call.reject("overlay permission not granted");
            return;
        }
        Intent serviceIntent = new Intent(getContext(), OverlayBubbleService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getContext().startForegroundService(serviceIntent);
        } else {
            getContext().startService(serviceIntent);
        }
        call.resolve();
    }

    @PluginMethod
    public void stopBubble(PluginCall call) {
        getContext().stopService(new Intent(getContext(), OverlayBubbleService.class));
        call.resolve();
    }

    private boolean hasOverlayPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            return Settings.canDrawOverlays(getContext());
        }
        return true;
    }
}
