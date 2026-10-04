package com.kamedono.mydatabase;

import android.appwidget.AppWidgetManager;
import android.app.Activity;
import android.content.Context;
import android.graphics.Rect;
import android.os.Bundle;
import android.util.DisplayMetrics;
import android.view.View;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.util.ArrayList;
import java.util.List;

/**
 * NoteWidgetProviderをタップした時に開く、タイトル/内容/タグの入力カード。
 * intent.sourceBoundsにタップしたウィジェットの画面上の位置・大きさが入っているので、
 * そこを起点にカードを広げ、「ウィジェットがそのまま入力欄に変わった」ように見せる
 * (ヤモリめものMemoEditActivityと同じ手法)。ウィジェットが小さい場合は入力に
 * 十分な最低サイズまで広げ、タップした位置を中心に配置する。
 */
public class NoteQuickAddActivity extends Activity {

    private NoteBridge bridge;
    private EditText titleInput;
    private EditText contentInput;
    private EditText tagsInput;
    private TextView statusText;
    private TextView saveButton;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_note_quickadd);

        View scrim = findViewById(R.id.quickaddScrim);
        FrameLayout card = findViewById(R.id.quickaddCard);
        positionCard(card);

        titleInput = findViewById(R.id.quickaddTitleInput);
        contentInput = findViewById(R.id.quickaddContentInput);
        tagsInput = findViewById(R.id.quickaddTagsInput);
        LinearLayout tagChips = findViewById(R.id.quickaddTagChips);
        statusText = findViewById(R.id.quickaddStatusText);
        TextView cancelButton = findViewById(R.id.quickaddCancelButton);
        saveButton = findViewById(R.id.quickaddSaveButton);

        scrim.setOnClickListener(v -> finish());
        card.setOnClickListener(v -> { /* カード内タップでは閉じない */ });
        cancelButton.setOnClickListener(v -> finish());
        saveButton.setOnClickListener(v -> save());

        bridge = new NoteBridge(this, card);
        bridge.fetchTags(tags -> populateTagChips(tagChips, tagsInput, tags));

        titleInput.requestFocus();
    }

    /** 既存タグをタップ候補として並べる。タップで tagsInput にカンマ区切りで追加/解除する。 */
    private void populateTagChips(LinearLayout container, EditText tagsField, List<String> tags) {
        if (container == null || tags.isEmpty()) return;
        int paddingH = dp(10), paddingV = dp(5), marginEnd = dp(6);
        for (String tag : tags) {
            TextView chip = new TextView(this);
            chip.setText(tag);
            chip.setTextSize(12);
            chip.setPadding(paddingH, paddingV, paddingH, paddingV);
            chip.setBackgroundResource(R.drawable.bg_bubble_circle);
            chip.setTextColor(0xFFFFFFFF);
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT
            );
            lp.setMarginEnd(marginEnd);
            chip.setLayoutParams(lp);
            chip.setOnClickListener(v -> {
                List<String> current = parseTags(tagsField.getText().toString());
                if (current.contains(tag)) {
                    current.remove(tag);
                } else {
                    current.add(tag);
                }
                tagsField.setText(String.join(", ", current));
                tagsField.setSelection(tagsField.getText().length());
            });
            container.addView(chip);
        }
    }

    private void positionCard(FrameLayout card) {
        int minWidthPx = dp(280);
        int minHeightPx = dp(320);

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

    private void save() {
        String title = titleInput.getText().toString().trim();
        String content = contentInput.getText().toString().trim();
        List<String> tags = parseTags(tagsInput.getText().toString());
        if (title.isEmpty() && content.isEmpty()) {
            finish();
            return;
        }
        statusText.setText("保存中...");
        saveButton.setEnabled(false);
        bridge.save(title, content, tags, ok -> {
            saveButton.setEnabled(true);
            if (ok) {
                statusText.setText("保存しました");
                titleInput.postDelayed(this::finish, 350);
            } else {
                statusText.setText("保存に失敗しました。もう一度お試しください");
            }
        });
    }

    private List<String> parseTags(String raw) {
        List<String> tags = new ArrayList<>();
        if (raw == null) return tags;
        for (String part : raw.split("[,、]")) {
            String trimmed = part.trim();
            if (!trimmed.isEmpty()) tags.add(trimmed);
        }
        return tags;
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
