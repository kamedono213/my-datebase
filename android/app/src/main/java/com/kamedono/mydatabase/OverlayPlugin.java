package com.kamedono.mydatabase;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.text.TextUtils;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Web側（app.js等）から常駐アイコンのON/OFF・権限確認を行うためのブリッジ。
 */
@CapacitorPlugin(name = "OverlayBubble")
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

    // 「選択中の文字列だけを転記する」機能に使う、アクセシビリティサービスの権限。
    // 重ねて表示より強い権限なので、ユーザーが明示的にONにした時だけ使う。
    @PluginMethod
    public void checkSelectionPermission(PluginCall call) {
        JSObject result = new JSObject();
        result.put("granted", hasSelectionPermission());
        call.resolve(result);
    }

    @PluginMethod
    public void requestSelectionPermission(PluginCall call) {
        if (!hasSelectionPermission()) {
            Intent intent = new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
        }
        JSObject result = new JSObject();
        result.put("granted", hasSelectionPermission());
        call.resolve(result);
    }

    private boolean hasSelectionPermission() {
        String target = getContext().getPackageName() + "/" + SelectionAccessibilityService.class.getCanonicalName();
        String enabledServices = Settings.Secure.getString(
            getContext().getContentResolver(),
            Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
        );
        if (TextUtils.isEmpty(enabledServices)) return false;
        TextUtils.SimpleStringSplitter splitter = new TextUtils.SimpleStringSplitter(':');
        splitter.setString(enabledServices);
        while (splitter.hasNext()) {
            if (splitter.next().equalsIgnoreCase(target)) return true;
        }
        return false;
    }
}
