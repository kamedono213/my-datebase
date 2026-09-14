package com.kamedono.mydatabase;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.graphics.PixelFormat;
import android.os.Build;
import android.os.IBinder;
import android.view.Gravity;
import android.view.LayoutInflater;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebView;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.TextView;
import org.json.JSONObject;

/**
 * 画面のどこにいても押せる「本アイコン」を常駐表示するフォアグラウンドサービス。
 * タップすると、別の画面に移動せず、その場でカード状の入力欄を展開する。
 * 保存は隠しWebView(overlaybridge.html)経由で、既存アプリと同じIndexedDBに書き込む。
 */
public class OverlayBubbleService extends Service {

    public static final String CHANNEL_ID = "overlay_bubble_channel";
    private static final int NOTIFICATION_ID = 1001;
    private static final int TAP_MOVE_THRESHOLD_PX = 18;

    private WindowManager windowManager;

    private View bubbleView;
    private WindowManager.LayoutParams bubbleParams;
    private boolean bubbleAdded = false;

    private View cardView;
    private WindowManager.LayoutParams cardParams;
    private boolean cardAdded = false;

    private WebView bridgeWebView;
    private boolean bridgeReady = false;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        startForeground(NOTIFICATION_ID, buildNotification());
        windowManager = (WindowManager) getSystemService(Context.WINDOW_SERVICE);
        setupBridgeWebView();
        addBubbleView();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        removeBubbleView();
        if (cardAdded && cardView != null) {
            try {
                windowManager.removeView(cardView);
            } catch (IllegalArgumentException ignored) {
            }
            cardAdded = false;
        }
        if (bridgeWebView != null) {
            bridgeWebView.destroy();
        }
    }

    // ---- 通知(フォアグラウンドサービスに必須) ----

    private Notification buildNotification() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager != null) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "常駐メモアイコン",
                NotificationManager.IMPORTANCE_MIN
            );
            channel.setDescription("画面に常駐するメモ追加アイコンを表示しています");
            manager.createNotificationChannel(channel);
        }

        Notification.Builder builder = (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            ? new Notification.Builder(this, CHANNEL_ID)
            : new Notification.Builder(this);

        return builder
            .setContentTitle("知識データベース")
            .setContentText("常駐メモアイコンが有効です")
            .setSmallIcon(android.R.drawable.ic_menu_edit)
            .setOngoing(true)
            .build();
    }

    // ---- 保存用の隠しWebView ----

    private void setupBridgeWebView() {
        bridgeWebView = new WebView(this);
        bridgeWebView.getSettings().setJavaScriptEnabled(true);
        bridgeWebView.getSettings().setDomStorageEnabled(true);
        bridgeWebView.getSettings().setDatabaseEnabled(true);
        bridgeWebView.loadUrl("file:///android_asset/public/overlaybridge.html");

        // 画面には映さないが、WebViewが正しく動くにはウィンドウに追加されている必要がある
        WindowManager.LayoutParams hiddenParams = new WindowManager.LayoutParams(
            1,
            1,
            overlayType(),
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE,
            PixelFormat.TRANSLUCENT
        );
        hiddenParams.gravity = Gravity.TOP | Gravity.START;
        try {
            windowManager.addView(bridgeWebView, hiddenParams);
        } catch (Exception ignored) {
            // オーバーレイ権限が無い等で失敗した場合でも致命的にはしない
        }
    }

    private void saveNote(String title, String content, Runnable onDone) {
        String js = "window.__overlaySave && window.__overlaySave(" + JSONObject.quote(title) + "," + JSONObject.quote(content) + ")";
        bridgeWebView.evaluateJavascript(js, value -> {
            if (onDone != null) onDone.run();
        });
    }

    private int overlayType() {
        return (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
            : WindowManager.LayoutParams.TYPE_PHONE;
    }

    // ---- ふきだしアイコン(たたんだ状態) ----

    private void addBubbleView() {
        ImageView icon = new ImageView(this);
        icon.setImageResource(R.drawable.ic_bubble_book);
        icon.setBackgroundResource(R.drawable.bg_bubble_circle);
        int paddingPx = dpToPx(14);
        icon.setPadding(paddingPx, paddingPx, paddingPx, paddingPx);
        bubbleView = icon;

        bubbleParams = new WindowManager.LayoutParams(
            dpToPx(48),
            dpToPx(48),
            overlayType(),
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT
        );
        bubbleParams.gravity = Gravity.TOP | Gravity.START;
        bubbleParams.x = 0;
        bubbleParams.y = dpToPx(160);

        windowManager.addView(bubbleView, bubbleParams);
        bubbleAdded = true;

        bubbleView.setOnTouchListener(new View.OnTouchListener() {
            private int initialX;
            private int initialY;
            private float initialTouchX;
            private float initialTouchY;
            private boolean moved;

            @Override
            public boolean onTouch(View v, MotionEvent event) {
                switch (event.getAction()) {
                    case MotionEvent.ACTION_DOWN:
                        initialX = bubbleParams.x;
                        initialY = bubbleParams.y;
                        initialTouchX = event.getRawX();
                        initialTouchY = event.getRawY();
                        moved = false;
                        return true;
                    case MotionEvent.ACTION_MOVE: {
                        int dx = (int) (event.getRawX() - initialTouchX);
                        int dy = (int) (event.getRawY() - initialTouchY);
                        if (Math.abs(dx) > TAP_MOVE_THRESHOLD_PX || Math.abs(dy) > TAP_MOVE_THRESHOLD_PX) {
                            moved = true;
                        }
                        bubbleParams.x = initialX + dx;
                        bubbleParams.y = initialY + dy;
                        if (bubbleAdded) windowManager.updateViewLayout(bubbleView, bubbleParams);
                        return true;
                    }
                    case MotionEvent.ACTION_UP:
                        if (!moved) {
                            expandCard();
                        }
                        return true;
                }
                return false;
            }
        });
    }

    private void removeBubbleView() {
        if (bubbleAdded && bubbleView != null) {
            try {
                windowManager.removeView(bubbleView);
            } catch (IllegalArgumentException ignored) {
            }
            bubbleAdded = false;
        }
    }

    // ---- クイック入力カード(展開した状態) ----

    private void expandCard() {
        removeBubbleView();

        cardView = LayoutInflater.from(this).inflate(R.layout.overlay_quickadd, null);
        EditText titleInput = cardView.findViewById(R.id.overlayTitleInput);
        EditText contentInput = cardView.findViewById(R.id.overlayContentInput);
        TextView statusText = cardView.findViewById(R.id.overlayStatusText);
        TextView cancelButton = cardView.findViewById(R.id.overlayCancelButton);
        TextView saveButton = cardView.findViewById(R.id.overlaySaveButton);

        cancelButton.setOnClickListener(v -> collapseCard());

        saveButton.setOnClickListener(v -> {
            String title = titleInput.getText().toString().trim();
            String content = contentInput.getText().toString().trim();
            if (title.isEmpty() && content.isEmpty()) {
                collapseCard();
                return;
            }
            statusText.setText("保存中...");
            saveNote(title, content, () -> {
                statusText.setText("保存しました");
                cardView.postDelayed(this::collapseCard, 350);
            });
        });

        cardParams = new WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            overlayType(),
            WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT
        );
        // このウィンドウだけは入力を受け付けたいのでFLAG_NOT_FOCUSABLEを付けない。
        // キーボードで隠れないよう、パン方式で調整する。
        cardParams.softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_PAN
            | WindowManager.LayoutParams.SOFT_INPUT_STATE_VISIBLE;
        cardParams.gravity = Gravity.TOP | Gravity.START;
        cardParams.x = dpToPx(16);
        cardParams.y = dpToPx(120);

        windowManager.addView(cardView, cardParams);
        cardAdded = true;
        titleInput.requestFocus();
    }

    private void collapseCard() {
        if (cardAdded && cardView != null) {
            try {
                windowManager.removeView(cardView);
            } catch (IllegalArgumentException ignored) {
            }
            cardAdded = false;
            cardView = null;
        }
        if (!bubbleAdded) {
            addBubbleView();
        }
    }

    private int dpToPx(int dp) {
        float density = getResources().getDisplayMetrics().density;
        return Math.round(dp * density);
    }
}
