package com.kamedono.mydatabase;

import android.app.Activity;
import android.graphics.Rect;
import android.os.Bundle;
import android.util.DisplayMetrics;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.TextView;

/**
 * QuizWidgetProvider(1×1の「？」タイル)をタップした時にカットインで出る、
 * ランダム出題クイズのポップアップ。アプリ内の「？」クイズ(openQuizNote、app.js)と
 * 同じ流れ: タイトルを見せる→タップで答え(内容)を見せる。
 * intent.sourceBoundsを起点に、タップしたウィジェットの位置から広がるように配置する。
 */
public class QuizRevealActivity extends Activity {

    private NoteBridge bridge;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_quiz_reveal);

        View scrim = findViewById(R.id.quizScrim);
        FrameLayout card = findViewById(R.id.quizCard);
        positionCard(card);

        TextView titleText = findViewById(R.id.quizTitleText);
        TextView contentText = findViewById(R.id.quizContentText);
        TextView revealButton = findViewById(R.id.quizRevealButton);
        TextView closeButton = findViewById(R.id.quizCloseButton);

        titleText.setText("読み込み中...");
        revealButton.setVisibility(View.INVISIBLE);

        scrim.setOnClickListener(v -> finish());
        card.setOnClickListener(v -> { /* カード内タップでは閉じない */ });
        closeButton.setOnClickListener(v -> finish());

        bridge = new NoteBridge(this, card);
        bridge.fetchRandomNote((ok, title, content) -> {
            if (!ok) {
                titleText.setText("メモがまだありません");
                return;
            }
            titleText.setText(title);
            revealButton.setVisibility(View.VISIBLE);
            revealButton.setOnClickListener(v -> {
                contentText.setText(content);
                contentText.setVisibility(View.VISIBLE);
                revealButton.setVisibility(View.GONE);
            });
        });
    }

    private void positionCard(FrameLayout card) {
        int minWidthPx = dp(260);
        int minHeightPx = dp(180);

        DisplayMetrics metrics = getResources().getDisplayMetrics();
        Rect bounds = getIntent().getSourceBounds();

        int width = minWidthPx;
        int height = minHeightPx;
        int left;
        int top;

        if (bounds != null) {
            width = Math.max(bounds.width(), minWidthPx);
            height = Math.max(bounds.height(), minHeightPx);
            left = bounds.centerX() - width / 2;
            top = bounds.centerY() - height / 2;
        } else {
            left = (metrics.widthPixels - width) / 2;
            top = (metrics.heightPixels - height) / 2;
        }

        int margin = dp(12);
        left = Math.max(margin, Math.min(left, metrics.widthPixels - width - margin));
        top = Math.max(margin, Math.min(top, metrics.heightPixels - height - margin));

        FrameLayout.LayoutParams lp = (FrameLayout.LayoutParams) card.getLayoutParams();
        lp.width = width;
        lp.height = height;
        lp.leftMargin = left;
        lp.topMargin = top;
        card.setLayoutParams(lp);
    }

    @Override
    public void onBackPressed() {
        finish();
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        if (bridge != null) bridge.destroy();
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
