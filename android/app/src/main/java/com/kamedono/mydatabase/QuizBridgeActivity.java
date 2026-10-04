package com.kamedono.mydatabase;

import android.app.Activity;
import android.appwidget.AppWidgetManager;
import android.os.Bundle;
import android.widget.FrameLayout;

/**
 * QuizWidgetProviderのタップに応答して、見た目には何も表示せずランダムな1件を
 * 取得してすぐ閉じるだけのトランポリンActivity。完全に透明なテーマ+アニメ無しのため、
 * ユーザーからは「ウィジェットがその場で次の問題に切り替わった」ように見える。
 */
public class QuizBridgeActivity extends Activity {

    private NoteBridge bridge;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        int appWidgetId = getIntent().getIntExtra(
            AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID
        );
        if (appWidgetId == AppWidgetManager.INVALID_APPWIDGET_ID) {
            finish();
            return;
        }

        FrameLayout root = new FrameLayout(this);
        setContentView(root);

        bridge = new NoteBridge(this, root);
        bridge.fetchRandomNote((ok, title, content) -> {
            AppWidgetManager manager = AppWidgetManager.getInstance(this);
            if (ok) {
                QuizWidgetProvider.saveRandomNote(this, appWidgetId, title, content);
                QuizWidgetProvider.updateWidget(this, manager, appWidgetId);
            } else {
                QuizWidgetProvider.showEmptyState(this, manager, appWidgetId);
            }
            finish();
        });
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        if (bridge != null) bridge.destroy();
    }
}
