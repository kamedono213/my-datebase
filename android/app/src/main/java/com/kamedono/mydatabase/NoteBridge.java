package com.kamedono.mydatabase;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.webkit.WebViewAssetLoader;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * ウィジェット用の隠しWebViewブリッジ。OverlayBubbleServiceと同じ理屈
 * (overlaybridge.htmlをWebViewAssetLoader経由でhttps://localhostから読み込み、
 * 本体アプリと同じIndexedDBに書き込む/読み出す)だが、WindowManagerのオーバーレイ
 * 権限には依存しない。呼び出し元(通常のActivity)が持つViewGroupに1x1dpの不可視
 * Viewとして差し込むだけで動く。
 */
public class NoteBridge {

    public interface SaveCallback {
        void onResult(boolean ok);
    }

    public interface RandomNoteCallback {
        void onResult(boolean ok, String title, String content);
    }

    public interface TagsCallback {
        void onResult(List<String> tags);
    }

    private final WebView webView;
    private boolean ready = false;
    private final List<Runnable> pendingActions = new ArrayList<>();
    private int nextRequestId = 1;
    private final Map<Integer, SaveCallback> saveCallbacks = new HashMap<>();
    private final Map<Integer, RandomNoteCallback> randomCallbacks = new HashMap<>();
    private final Map<Integer, TagsCallback> tagsCallbacks = new HashMap<>();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    public NoteBridge(Context context, ViewGroup attachTo) {
        WebViewAssetLoader assetLoader = new WebViewAssetLoader.Builder()
            .setDomain("localhost")
            .addPathHandler("/", new WebViewAssetLoader.AssetsPathHandler(context))
            .build();

        webView = new WebView(context);
        webView.getSettings().setJavaScriptEnabled(true);
        webView.getSettings().setDomStorageEnabled(true);
        webView.getSettings().setDatabaseEnabled(true);
        webView.addJavascriptInterface(new JsBridge(), "AndroidBridge");
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return assetLoader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                ready = true;
                List<Runnable> queued = new ArrayList<>(pendingActions);
                pendingActions.clear();
                for (Runnable action : queued) action.run();
            }
        });

        ViewGroup.LayoutParams lp = new ViewGroup.LayoutParams(1, 1);
        webView.setLayoutParams(lp);
        attachTo.addView(webView);
        webView.loadUrl("https://localhost/public/overlaybridge.html");
    }

    private class JsBridge {
        @JavascriptInterface
        public void onSaveResult(int requestId, boolean ok, String message) {
            mainHandler.post(() -> {
                SaveCallback callback = saveCallbacks.remove(requestId);
                if (callback != null) callback.onResult(ok);
            });
        }

        @JavascriptInterface
        public void onRandomNoteResult(int requestId, boolean ok, String title, String content) {
            mainHandler.post(() -> {
                RandomNoteCallback callback = randomCallbacks.remove(requestId);
                if (callback != null) callback.onResult(ok, title, content);
            });
        }

        @JavascriptInterface
        public void onTagsResult(int requestId, String namesJson) {
            mainHandler.post(() -> {
                TagsCallback callback = tagsCallbacks.remove(requestId);
                if (callback == null) return;
                List<String> names = new java.util.ArrayList<>();
                try {
                    JSONArray arr = new JSONArray(namesJson);
                    for (int i = 0; i < arr.length(); i++) names.add(arr.getString(i));
                } catch (Exception ignored) {
                }
                callback.onResult(names);
            });
        }
    }

    public void save(String title, String content, List<String> tags, SaveCallback callback) {
        int requestId = nextRequestId++;
        saveCallbacks.put(requestId, callback);

        Runnable attempt = () -> {
            JSONArray tagsArray = new JSONArray();
            for (String t : tags) tagsArray.put(t);
            String js = "window.__overlaySave(" + requestId + ","
                + JSONObject.quote(title) + ","
                + JSONObject.quote(content) + ","
                + tagsArray.toString() + ")";
            webView.evaluateJavascript(js, null);
        };

        if (ready) {
            attempt.run();
        } else {
            pendingActions.add(attempt);
        }

        mainHandler.postDelayed(() -> {
            SaveCallback stillPending = saveCallbacks.remove(requestId);
            if (stillPending != null) stillPending.onResult(false);
        }, 8000);
    }

    public void fetchRandomNote(RandomNoteCallback callback) {
        int requestId = nextRequestId++;
        randomCallbacks.put(requestId, callback);

        Runnable attempt = () -> webView.evaluateJavascript(
            "window.__overlayRandomNote(" + requestId + ")", null
        );

        if (ready) {
            attempt.run();
        } else {
            pendingActions.add(attempt);
        }

        mainHandler.postDelayed(() -> {
            RandomNoteCallback stillPending = randomCallbacks.remove(requestId);
            if (stillPending != null) stillPending.onResult(false, "", "");
        }, 8000);
    }

    public void fetchTags(TagsCallback callback) {
        int requestId = nextRequestId++;
        tagsCallbacks.put(requestId, callback);

        Runnable attempt = () -> webView.evaluateJavascript(
            "window.__overlayGetTags(" + requestId + ")", null
        );

        if (ready) {
            attempt.run();
        } else {
            pendingActions.add(attempt);
        }

        mainHandler.postDelayed(() -> {
            TagsCallback stillPending = tagsCallbacks.remove(requestId);
            if (stillPending != null) stillPending.onResult(new java.util.ArrayList<>());
        }, 5000);
    }

    public void destroy() {
        webView.destroy();
    }
}
