package com.kamedono.mydatabase;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.os.Bundle;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * 常駐アイコンをタップした時に開く、ダイアログ風の小さなクイック追加画面。
 * quickadd.html（同じIndexedDBのdb.jsを使う）をWebViewで表示するだけの薄いラッパー。
 */
public class QuickAddActivity extends Activity {

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        WebView webView = new WebView(this);
        webView.getSettings().setJavaScriptEnabled(true);
        webView.getSettings().setDomStorageEnabled(true);
        webView.getSettings().setDatabaseEnabled(true);
        webView.setWebViewClient(new WebViewClient());
        webView.addJavascriptInterface(new JsBridge(), "AndroidBridge");
        webView.loadUrl("file:///android_asset/public/quickadd.html");
        setContentView(webView);

        WindowManager.LayoutParams params = getWindow().getAttributes();
        params.width = WindowManager.LayoutParams.MATCH_PARENT;
        params.height = WindowManager.LayoutParams.WRAP_CONTENT;
        getWindow().setAttributes(params);
    }

    private class JsBridge {
        @JavascriptInterface
        public void close() {
            runOnUiThread(QuickAddActivity.this::finish);
        }
    }
}
