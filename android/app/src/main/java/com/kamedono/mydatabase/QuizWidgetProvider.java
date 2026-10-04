package com.kamedono.mydatabase;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.widget.RemoteViews;

/**
 * 1×1マスの、アプリ内「？」クイズに相当するウィジェット。
 * タップするたびに: タイトル表示→(タップ)答え表示→(タップ)次のランダム出題、を繰り返す。
 * 「答え表示→次の出題」の切り替えだけDB読み込みが必要なため、その時だけ
 * QuizBridgeActivity(不可視)を一瞬起動してランダムな1件を取得する。
 */
public class QuizWidgetProvider extends AppWidgetProvider {

    private static final String PREFS_NAME = "picknote_quiz_widget_prefs";
    static final String ACTION_TOGGLE = "com.kamedono.mydatabase.QUIZ_TOGGLE";

    private static final int MODE_NEEDS_INIT = 0;
    private static final int MODE_QUESTION = 1;
    private static final int MODE_ANSWER = 2;

    @Override
    public void onUpdate(Context context, AppWidgetManager appWidgetManager, int[] appWidgetIds) {
        for (int appWidgetId : appWidgetIds) {
            updateWidget(context, appWidgetManager, appWidgetId);
        }
    }

    @Override
    public void onDeleted(Context context, int[] appWidgetIds) {
        SharedPreferences.Editor editor = prefs(context).edit();
        for (int appWidgetId : appWidgetIds) {
            editor.remove(modeKey(appWidgetId));
            editor.remove(titleKey(appWidgetId));
            editor.remove(contentKey(appWidgetId));
        }
        editor.apply();
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        super.onReceive(context, intent);
        if (!ACTION_TOGGLE.equals(intent.getAction())) return;

        int appWidgetId = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID);
        if (appWidgetId == AppWidgetManager.INVALID_APPWIDGET_ID) return;

        int mode = prefs(context).getInt(modeKey(appWidgetId), MODE_NEEDS_INIT);
        if (mode == MODE_QUESTION) {
            // 出題中の答えを見るだけなら、キャッシュしてある内容をそのまま出すので十分。
            prefs(context).edit().putInt(modeKey(appWidgetId), MODE_ANSWER).apply();
            updateWidget(context, AppWidgetManager.getInstance(context), appWidgetId);
            return;
        }

        // 初回、または答えを見た後の次の出題は、新しいランダム1件が必要なので
        // 一瞬だけ不可視のブリッジActivityを起動してDBを読みに行く。
        Intent bridgeIntent = new Intent(context, QuizBridgeActivity.class);
        bridgeIntent.putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId);
        bridgeIntent.setFlags(
            Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_NO_ANIMATION
        );
        context.startActivity(bridgeIntent);
    }

    static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    private static String modeKey(int appWidgetId) {
        return "mode_" + appWidgetId;
    }

    private static String titleKey(int appWidgetId) {
        return "title_" + appWidgetId;
    }

    private static String contentKey(int appWidgetId) {
        return "content_" + appWidgetId;
    }

    static void saveRandomNote(Context context, int appWidgetId, String title, String content) {
        prefs(context).edit()
            .putInt(modeKey(appWidgetId), MODE_QUESTION)
            .putString(titleKey(appWidgetId), title)
            .putString(contentKey(appWidgetId), content)
            .apply();
    }

    static void showEmptyState(Context context, AppWidgetManager appWidgetManager, int appWidgetId) {
        RemoteViews views = buildViews(context, appWidgetId, "メモが\nありません");
        appWidgetManager.updateAppWidget(appWidgetId, views);
    }

    static void updateWidget(Context context, AppWidgetManager appWidgetManager, int appWidgetId) {
        int mode = prefs(context).getInt(modeKey(appWidgetId), MODE_NEEDS_INIT);
        String text;
        if (mode == MODE_ANSWER) {
            text = prefs(context).getString(contentKey(appWidgetId), "");
        } else if (mode == MODE_QUESTION) {
            text = prefs(context).getString(titleKey(appWidgetId), "");
        } else {
            text = "？\nタップしてね";
        }
        appWidgetManager.updateAppWidget(appWidgetId, buildViews(context, appWidgetId, text));
    }

    private static RemoteViews buildViews(Context context, int appWidgetId, String text) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_quiz);
        views.setTextViewText(R.id.quizText, text);

        Intent toggleIntent = new Intent(context, QuizWidgetProvider.class);
        toggleIntent.setAction(ACTION_TOGGLE);
        toggleIntent.putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId);
        PendingIntent pendingIntent = PendingIntent.getBroadcast(
            context, appWidgetId, toggleIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        views.setOnClickPendingIntent(R.id.quizWidgetRoot, pendingIntent);
        return views;
    }
}
